import {
  archiveInboxItem,
  fetchInbox,
  markAllInboxRead,
  markInboxItemRead,
  type InboxAuth,
  type SdkApi,
  type SdkInboxItem,
} from './api.js';
import type { Logger } from './logger.js';
import type { InboxChangeEvent, InboxItem, InboxListOptions, InboxPage } from './types.js';

export interface InboxHost {
  api: () => SdkApi | null;
  /** Kullanıcı ve ona ait abonelik; yoksa null (anlamlı hata fırlatılır). */
  auth: () => InboxAuth | null;
  logger: Logger;
}

/** API öğesini SDK biçimine (camelCase) çevirir. */
export function toInboxItem(item: SdkInboxItem): InboxItem {
  return {
    id: item.id,
    messageId: item.message_id,
    title: item.title,
    body: item.body,
    url: item.url,
    imageUrl: item.image_url,
    data: item.data ?? {},
    read: item.read,
    readAt: item.read_at,
    archivedAt: item.archived_at,
    expiresAt: item.expires_at,
    createdAt: item.created_at,
  };
}

/**
 * Bildirim kutusu (`Pushizo.Inbox`): liste, okundu işaretleme, arşivleme ve okunmamış sayısı.
 * İstekler doğrudan gönderilir (yanıt gerekir); okunmamış sayısı değişince gözlemciler bilgilendirilir.
 */
export class InboxClient {
  private unread: number | null = null;
  /** Son listelenen öğelerin okunma durumu (okunmamış sayısını yerelde güncellemek için). */
  private readonly known = new Map<string, boolean>();
  private readonly observers = new Set<(event: InboxChangeEvent) => void>();

  constructor(private readonly host: InboxHost) {}

  private context(): { api: SdkApi; auth: InboxAuth } {
    const api = this.host.api();
    if (!api) throw new Error('Pushizo.init önce çağrılmalı.');
    const auth = this.host.auth();
    if (!auth)
      throw new Error(
        'Pushizo.Inbox: kullanıcı veya abonelik yok. Önce bildirim aboneliği oluşturun, login olun ya da User.addEmail/addSms kullanın.',
      );
    return { api, auth };
  }

  async list(options: InboxListOptions = {}): Promise<InboxPage> {
    const { api, auth } = this.context();
    const limit =
      options.limit === undefined
        ? undefined
        : Math.min(200, Math.max(1, Math.floor(options.limit)));
    const page = await fetchInbox(api, auth, { limit, cursor: options.cursor });
    const items = page.data.map(toInboxItem);
    if (!options.cursor) this.known.clear();
    for (const item of items) this.known.set(item.id, item.read);
    this.setUnread(page.unread_count, { type: 'listed', unreadCount: page.unread_count });
    return {
      items,
      unreadCount: page.unread_count,
      nextCursor: page.next_cursor,
      hasMore: page.has_more,
    };
  }

  async markRead(itemId: string): Promise<InboxItem> {
    const { api, auth } = this.context();
    const wasUnread = this.known.get(itemId) === false;
    const item = toInboxItem(await markInboxItemRead(api, auth, itemId));
    this.known.set(itemId, true);
    const count =
      wasUnread && this.unread !== null ? Math.max(0, this.unread - 1) : await this.fetchCount();
    this.setUnread(count, { type: 'read', itemId, unreadCount: count });
    return item;
  }

  async markAllRead(): Promise<{ updated: number; unreadCount: number }> {
    const { api, auth } = this.context();
    const result = await markAllInboxRead(api, auth);
    for (const id of this.known.keys()) this.known.set(id, true);
    this.setUnread(result.unread_count, { type: 'read_all', unreadCount: result.unread_count });
    return { updated: result.updated, unreadCount: result.unread_count };
  }

  /** Öğeyi kutudan kaldırır (sunucuda arşivlenir). */
  async archive(itemId: string): Promise<void> {
    const { api, auth } = this.context();
    const wasUnread = this.known.get(itemId) === false;
    const wasKnown = this.known.has(itemId);
    await archiveInboxItem(api, auth, itemId);
    this.known.delete(itemId);
    const count =
      wasKnown && this.unread !== null
        ? Math.max(0, this.unread - (wasUnread ? 1 : 0))
        : await this.fetchCount();
    this.setUnread(count, { type: 'archived', itemId, unreadCount: count });
  }

  /** Okunmamış öğe sayısı (sunucudan). */
  async unreadCount(): Promise<number> {
    this.context();
    const count = await this.fetchCount();
    this.setUnread(count, { type: 'count', unreadCount: count });
    return count;
  }

  addObserver(cb: (event: InboxChangeEvent) => void): () => void {
    this.observers.add(cb);
    return () => this.observers.delete(cb);
  }

  removeObserver(cb: (event: InboxChangeEvent) => void): void {
    this.observers.delete(cb);
  }

  /** Kullanıcı değişince (login/logout) önbellek temizlenir. */
  reset(): void {
    this.known.clear();
    this.unread = null;
  }

  private async fetchCount(): Promise<number> {
    const { api, auth } = this.context();
    const page = await fetchInbox(api, auth, { limit: 1 });
    return page.unread_count;
  }

  /** Okunmamış sayısı değiştiyse veya öğe değiştiyse gözlemcileri bilgilendirir. */
  private setUnread(count: number, event: InboxChangeEvent): void {
    const changed = this.unread !== count;
    this.unread = count;
    if (!changed && (event.type === 'listed' || event.type === 'count')) return;
    for (const cb of this.observers) {
      try {
        cb(event);
      } catch (err) {
        this.host.logger.error('inbox gözlemcisi hata verdi', err);
      }
    }
  }
}
