import { ApiError, queryString, type SdkApi } from './api.js';
import type { Logger } from './logger.js';
import type { KeyValueStore } from './storage.js';

/**
 * Canlı sohbet istemcisi (`Pushizo.Chat`; ADR-0040). Ziyaretçi kimliği ve gizli belirteç tarayıcıda üretilip
 * saklanır (sunucu yalnızca özetini tutar). Gerçek zamanlı iletim SSE (`chat/stream`) + POST; SSE yoksa veya koparsa
 * `after_seq` yoklaması. Mesajlar sunucu sıra numarasıyla (`seq`) sıralanır, `client_message_id` yeniden göndermede
 * tekilleşir. Widget arayüzü ayrı pakette (`PushizoChatWidget.js`) tembel yüklenir.
 */

export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface ChatQuickReply {
  id: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  seq: number;
  client_message_id: string | null;
  sender: 'visitor' | 'agent' | 'bot' | 'system';
  author_name: string | null;
  text: string | null;
  attachments: ChatAttachment[];
  quick_replies: ChatQuickReply[] | null;
  status: 'sent' | 'delivered' | 'read';
  created_at: string;
  /** Yalnızca istemci: gönderiliyor / gönderilemedi (yeniden denenebilir). */
  pending?: boolean;
  failed?: boolean;
}

export interface ChatConversation {
  id: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  last_seq: number;
  agent_last_read_seq: number;
  visitor_last_read_seq: number;
  unread_count: number;
  bot_active: boolean;
  assignee_name: string | null;
  created_at: string;
}

export interface ChatConfig {
  enabled: boolean;
  online: boolean;
  within_business_hours: boolean;
  color: string | null;
  text_color: string | null;
  position: 'right' | 'left';
  theme: 'light' | 'dark' | 'auto';
  title: string | null;
  greeting: string | null;
  offline_message: string | null;
  collect_email_offline: boolean;
  require_email: boolean;
  attachments: { enabled: boolean; max_bytes: number; types: string[] };
  language: string;
}

export interface ChatEvents {
  /** Yeni veya güncellenen mesaj listesi (sıra numarasıyla sıralı). */
  messages: ChatMessage[];
  typing: { typing: boolean; name: string | null };
  /** Temsilci okudu: bu sıra numarasına kadar ziyaretçi mesajları okundu. */
  read: { seq: number };
  conversation: ChatConversation | null;
  unread: number;
  /** Bağlantı durumu (canlı akış / yoklama / kapalı). */
  connection: 'live' | 'polling' | 'offline';
}

type Listener<K extends keyof ChatEvents> = (value: ChatEvents[K]) => void;

export interface ChatIdentity {
  externalId: string | null;
  identityHash: string | null;
  subscriptionId: string | null;
  tokenHash: string | null;
}

export interface ChatDeps {
  api: () => SdkApi | null;
  appId: () => string | null;
  storage: () => KeyValueStore | null;
  logger: Logger;
  language: () => string;
  identity: () => ChatIdentity;
  /** Gizlilik onayı yokken ağ isteği ve akış açılmaz. */
  allowed: () => boolean;
  fetch?: typeof fetch;
  eventSource?: typeof EventSource | null;
  /** Testler için yoklama aralığı (ms). */
  pollMs?: number;
}

interface StoredVisitor {
  visitorId: string;
  token: string;
  lastSeq: number;
  identityKey: string;
}

const POLL_MS = 5000;
const TYPING_THROTTLE_MS = 3000;

/** URL güvenli rastgele dize (base64url alfabesi). */
export function randomId(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b & 63];
  return out;
}

/** Mesaj listesini birleştirir: kimlik/istemci kimliğiyle tekilleştirir, sıra numarasına göre sıralar. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byKey = new Map<string, ChatMessage>();
  for (const m of current) byKey.set(m.client_message_id ?? m.id, m);
  for (const m of incoming) {
    const key = m.client_message_id ?? m.id;
    const prev = byKey.get(key) ?? [...byKey.values()].find((x) => x.id === m.id);
    if (prev && prev.client_message_id && prev.client_message_id !== key) byKey.delete(prev.client_message_id);
    byKey.set(key, { ...prev, ...m, pending: false, failed: false });
  }
  return [...byKey.values()].sort((a, b) => (a.pending || a.failed ? Infinity : a.seq) - (b.pending || b.failed ? Infinity : b.seq) || a.created_at.localeCompare(b.created_at));
}

/** Okundu/teslim işaretçilerini ziyaretçi mesajlarına uygular. */
function applyAgentRead(messages: ChatMessage[], seq: number): ChatMessage[] {
  return messages.map((m) => (m.sender === 'visitor' && !m.pending && m.seq <= seq && m.status !== 'read' ? { ...m, status: 'read' } : m));
}

export class ChatClient {
  private messagesList: ChatMessage[] = [];
  private conv: ChatConversation | null = null;
  private configCache: ChatConfig | null = null;
  private unreadCount = 0;
  private source: EventSource | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private streamFailures = 0;
  private lastTypingAt = 0;
  private connected = false;
  private identifyPromise: Promise<void> | null = null;
  private readonly listeners = new Map<keyof ChatEvents, Set<(value: unknown) => void>>();

  constructor(private readonly deps: ChatDeps) {}

  // ---------------------------------------------------------------- olaylar

  on<K extends keyof ChatEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const fn = cb as (value: unknown) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  private emit<K extends keyof ChatEvents>(event: K, value: ChatEvents[K]): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        cb(value);
      } catch (err) {
        this.deps.logger.warn('sohbet dinleyicisi hata verdi', err);
      }
    }
  }

  get messages(): ChatMessage[] {
    return this.messagesList;
  }

  get conversation(): ChatConversation | null {
    return this.conv;
  }

  get unread(): number {
    return this.unreadCount;
  }

  /**
   * Ziyaretçinin henüz okundu işaretlemediği temsilci/bot mesajı var mı. Okunmamış sayacından bağımsızdır: yoklama
   * (SSE yedeği) yolunda sayaç artmaz ve akış olayında sayaç `messages` olayından sonra güncellenir.
   */
  get hasUnread(): boolean {
    const readSeq = this.conv?.visitor_last_read_seq ?? 0;
    return this.unreadCount > 0 || this.messagesList.some((m) => m.sender !== 'visitor' && !m.pending && !m.failed && m.seq > readSeq);
  }

  // ---------------------------------------------------------------- kimlik

  private storageKey(): string {
    return `hs:${this.deps.appId() ?? 'app'}:chat`;
  }

  private identityKey(): string {
    const id = this.deps.identity();
    return `${id.externalId ?? ''}|${id.subscriptionId ?? ''}`;
  }

  /** Ziyaretçi kimliği ve belirteci (ilk çağrıda üretilir ve saklanır). */
  visitor(): StoredVisitor {
    const store = this.deps.storage();
    const key = this.storageKey();
    try {
      const raw = store?.getItem(key);
      if (raw) {
        const v = JSON.parse(raw) as Partial<StoredVisitor> & Pick<StoredVisitor, 'visitorId' | 'token'>;
        if (v.visitorId && v.token) return { ...v, lastSeq: v.lastSeq ?? 0, identityKey: v.identityKey ?? '' };
      }
    } catch {
      // Bozuk kayıt: yeniden üretilir.
    }
    const v: StoredVisitor = { visitorId: randomId(32), token: randomId(64), lastSeq: 0, identityKey: '' };
    this.persist(v);
    return v;
  }

  private persist(v: StoredVisitor): void {
    try {
      this.deps.storage()?.setItem(this.storageKey(), JSON.stringify(v));
    } catch {
      // Depolama kapalı: oturum boyunca bellekte.
    }
  }

  private auth(): { visitor_id: string; visitor_token: string } {
    const v = this.visitor();
    return { visitor_id: v.visitorId, visitor_token: v.token };
  }

  private query(extra: Record<string, string | number | undefined> = {}): string {
    const v = this.visitor();
    return queryString({ visitor_id: v.visitorId, token: v.token, ...extra });
  }

  private requireApi(): SdkApi {
    const api = this.deps.api();
    if (!api || !this.deps.allowed()) throw new ApiError(0, 'NOT_READY', 'Pushizo.init tamamlanmadı veya gizlilik onayı yok.');
    return api;
  }

  /**
   * Ziyaretçiyi giriş yapmış kullanıcıya (external_id + identity_hash/JWT) ve push aboneliğine (token_hash kanıtıyla)
   * bağlar. Kimlik değişmediyse istek atılmaz.
   */
  identify(force = false): Promise<void> {
    const key = this.identityKey();
    const v = this.visitor();
    if (!force && v.identityKey === key) return Promise.resolve();
    if (this.identifyPromise) return this.identifyPromise;
    const id = this.deps.identity();
    if (!id.externalId && !id.subscriptionId) return Promise.resolve();
    this.identifyPromise = this.requireApi()
      .request<{ conversation: ChatConversation | null }>('POST', '/chat/identify', {
        ...this.auth(),
        ...(id.externalId ? { external_id: id.externalId, ...(id.identityHash ? { identity_hash: id.identityHash } : {}) } : {}),
        ...(id.subscriptionId && id.tokenHash ? { subscription_id: id.subscriptionId, token_hash: id.tokenHash } : {}),
        language: this.deps.language(),
      })
      .then((res) => {
        this.persist({ ...this.visitor(), identityKey: key });
        if (res.conversation && res.conversation.id !== this.conv?.id) {
          this.setConversation(res.conversation);
          if (this.connected) this.reconnect();
        }
      })
      .catch((err: unknown) => this.deps.logger.warn('sohbet kimliği bağlanamadı', err))
      .finally(() => {
        this.identifyPromise = null;
      });
    return this.identifyPromise;
  }

  // ---------------------------------------------------------------- okuma

  async config(refresh = false): Promise<ChatConfig> {
    if (this.configCache && !refresh) return this.configCache;
    this.configCache = await this.requireApi().request<ChatConfig>('GET', `/chat/config${queryString({ language: this.deps.language() })}`);
    return this.configCache;
  }

  private setConversation(conv: ChatConversation | null): void {
    this.conv = conv;
    this.emit('conversation', conv);
    this.setUnread(conv?.unread_count ?? 0);
  }

  private setUnread(n: number): void {
    if (n === this.unreadCount) return;
    this.unreadCount = n;
    this.emit('unread', n);
  }

  /** Konuşma ve okunmamış sayısı (sunucudan). */
  async refresh(): Promise<ChatConversation | null> {
    const res = await this.requireApi().request<{ conversation: ChatConversation | null; unread_count: number }>('GET', `/chat/conversation${this.query()}`);
    this.setConversation(res.conversation);
    this.setUnread(res.unread_count);
    return res.conversation;
  }

  /** Son mesajlar (ilk açılış) veya `beforeSeq` öncesi geçmiş. */
  async load(beforeSeq?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const res = await this.requireApi().request<{ data: ChatMessage[]; has_more: boolean }>('GET', `/chat/messages${this.query({ before_seq: beforeSeq, limit: 50 })}`);
    this.ingest(res.data);
    return { messages: this.messagesList, hasMore: res.has_more };
  }

  private async catchUp(): Promise<void> {
    const after = this.maxSeq();
    const res = await this.requireApi().request<{ data: ChatMessage[]; has_more: boolean }>('GET', `/chat/messages${this.query({ after_seq: after, limit: 100 })}`);
    if (res.data.length) this.ingest(res.data);
  }

  private maxSeq(): number {
    return this.messagesList.reduce((m, x) => (x.pending || x.failed ? m : Math.max(m, x.seq)), 0);
  }

  private ingest(incoming: ChatMessage[]): void {
    if (!incoming.length) return;
    this.messagesList = mergeMessages(this.messagesList, incoming);
    const v = this.visitor();
    const max = this.maxSeq();
    if (max > v.lastSeq) this.persist({ ...v, lastSeq: max });
    this.emit('messages', this.messagesList);
  }

  // ---------------------------------------------------------------- yazma

  private optimistic(text: string, attachments: ChatAttachment[] = []): ChatMessage {
    return {
      id: `local-${randomId(12)}`,
      seq: Number.MAX_SAFE_INTEGER,
      client_message_id: `web-${randomId(20)}`,
      sender: 'visitor',
      author_name: null,
      text,
      attachments,
      quick_replies: null,
      status: 'sent',
      created_at: new Date().toISOString(),
      pending: true,
    };
  }

  private markFailed(clientId: string): void {
    this.messagesList = this.messagesList.map((m) => (m.client_message_id === clientId ? { ...m, pending: false, failed: true } : m));
    this.emit('messages', this.messagesList);
  }

  private afterSend(res: { message: ChatMessage; conversation: ChatConversation }): void {
    const first = !this.conv;
    this.ingest([res.message]);
    this.setConversation({ ...res.conversation, unread_count: this.unreadCount });
    // İlk mesaj konuşmayı açar: akış konuşmayı tanıyarak yeniden kurulur.
    if (first && this.connected) this.reconnect();
  }

  /**
   * Mesaj gönderir (iyimser gösterim). Ağ hatasında aynı `client_message_id` ile `retry` çağrılabilir; sunucu aynı
   * mesajı döndürür (çift kayıt olmaz).
   */
  async send(text: string, options: { optionId?: string; name?: string; email?: string } = {}): Promise<ChatMessage> {
    const body = text.trim();
    if (!body) throw new Error('Mesaj boş olamaz.');
    const local = this.optimistic(body);
    this.messagesList = [...this.messagesList, local];
    this.emit('messages', this.messagesList);
    return this.post(local, options);
  }

  private async post(local: ChatMessage, options: { optionId?: string; name?: string; email?: string }): Promise<ChatMessage> {
    try {
      const res = await this.requireApi().request<{ message: ChatMessage; conversation: ChatConversation }>('POST', '/chat/messages', {
        ...this.auth(),
        client_message_id: local.client_message_id,
        text: local.text,
        language: this.deps.language(),
        ...(options.optionId ? { option_id: options.optionId } : {}),
        ...(options.name ? { name: options.name } : {}),
        ...(options.email ? { email: options.email } : {}),
        ...(typeof location !== 'undefined' ? { page_url: location.href.slice(0, 2000) } : {}),
      });
      this.afterSend(res);
      return res.message;
    } catch (err) {
      this.markFailed(local.client_message_id!);
      throw err;
    }
  }

  /** Gönderilemeyen mesajı aynı istemci kimliğiyle yeniden dener. */
  async retry(clientMessageId: string): Promise<ChatMessage | null> {
    const m = this.messagesList.find((x) => x.client_message_id === clientMessageId && x.failed);
    if (!m) return null;
    this.messagesList = this.messagesList.map((x) => (x === m ? { ...x, failed: false, pending: true } : x));
    this.emit('messages', this.messagesList);
    return this.post(m, {});
  }

  /** Dosya/görsel eki (multipart); boyut ve tür sunucuda doğrulanır (10 MB; görsel, PDF, metin). */
  async sendFile(file: Blob, name: string, text = ''): Promise<ChatMessage> {
    const api = this.requireApi();
    const local = this.optimistic(text || name, [{ id: 'local', name, type: file.type, size: file.size }]);
    this.messagesList = [...this.messagesList, local];
    this.emit('messages', this.messagesList);
    const form = new FormData();
    const a = this.auth();
    form.set('visitor_id', a.visitor_id);
    form.set('visitor_token', a.visitor_token);
    form.set('client_message_id', local.client_message_id!);
    form.set('language', this.deps.language());
    if (text) form.set('text', text);
    form.set('file', file, name);
    const doFetch = this.deps.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
    try {
      const res = await doFetch(`${api.appBase}/chat/attachments`, { method: 'POST', body: form, credentials: 'omit' });
      const json = (await res.json().catch(() => ({}))) as { message?: ChatMessage; conversation?: ChatConversation; error?: { code?: string; message?: string } };
      if (!res.ok || !json.message || !json.conversation) throw new ApiError(res.status, json.error?.code ?? `HTTP_${res.status}`, json.error?.message ?? 'Dosya gönderilemedi.');
      this.afterSend({ message: json.message, conversation: json.conversation });
      return json.message;
    } catch (err) {
      this.markFailed(local.client_message_id!);
      throw err;
    }
  }

  /** Ek dosyasının adresi (görsel önizleme/indirme; ziyaretçi belirteciyle yetkili). */
  attachmentUrl(attachmentId: string, download = false): string {
    const api = this.requireApi();
    return `${api.appBase}/chat/attachments/${encodeURIComponent(attachmentId)}${this.query(download ? { download: 'true' } : {})}`;
  }

  /** Yazıyor göstergesi (3 sn'de en çok bir "yazıyor" isteği). */
  typing(isTyping: boolean): void {
    if (!this.conv || !this.deps.allowed()) return;
    const now = Date.now();
    if (isTyping && now - this.lastTypingAt < TYPING_THROTTLE_MS) return;
    this.lastTypingAt = isTyping ? now : 0;
    void this.deps.api()?.request('POST', '/chat/typing', { ...this.auth(), typing: isTyping }).catch(() => undefined);
  }

  /** Görülen son mesajı okundu işaretler (okunmamış sayısı sıfırlanır; temsilciye okundu bilgisi gider). */
  async markRead(): Promise<void> {
    if (!this.conv) return;
    const seq = this.maxSeq();
    if (seq <= this.conv.visitor_last_read_seq && this.unreadCount === 0) return;
    const res = await this.requireApi().request<{ conversation: ChatConversation | null; unread_count: number }>('POST', '/chat/ack', { ...this.auth(), read_seq: seq, delivered_seq: seq });
    if (res.conversation) this.conv = res.conversation;
    // Yanıttaki konuşma eski okundu sırasını taşısa bile gönderilen sıra okunmuş sayılır (tekrar işaretleme döngüsü olmaz).
    if (this.conv && this.conv.visitor_last_read_seq < seq) this.conv = { ...this.conv, visitor_last_read_seq: seq };
    this.setUnread(res.unread_count);
  }

  /** Çevrimdışı / çalışma saatleri dışında mesaj ve e-posta bırakma. */
  async leaveOfflineMessage(input: { email: string; text: string; name?: string }): Promise<ChatMessage> {
    const local = this.optimistic(input.text);
    const res = await this.requireApi().request<{ message: ChatMessage; conversation: ChatConversation }>('POST', '/chat/offline', {
      ...this.auth(),
      client_message_id: local.client_message_id,
      email: input.email,
      text: input.text,
      language: this.deps.language(),
      ...(input.name ? { name: input.name } : {}),
    });
    this.afterSend(res);
    return res.message;
  }

  // ---------------------------------------------------------------- canlı akış

  /** Canlı dinlemeyi başlatır (SSE; desteklenmiyorsa veya art arda koparsa yoklama). */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    await this.identify().catch(() => undefined);
    await this.refresh().catch((err: unknown) => this.deps.logger.debug('sohbet durumu okunamadı', err));
    if (this.conv) await this.load().catch(() => undefined);
    this.open();
  }

  disconnect(): void {
    this.connected = false;
    this.source?.close();
    this.source = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.emit('connection', 'offline');
  }

  private reconnect(): void {
    this.source?.close();
    this.source = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.open();
  }

  private open(): void {
    if (!this.connected || !this.deps.allowed()) return;
    const ES = this.deps.eventSource === undefined ? (typeof EventSource !== 'undefined' ? EventSource : null) : this.deps.eventSource;
    const api = this.deps.api();
    if (!ES || !api || this.streamFailures >= 3) {
      this.schedulePoll();
      return;
    }
    const es = new ES(`${api.appBase}/chat/stream${this.query({ after_seq: this.maxSeq() })}`);
    this.source = es;
    es.addEventListener('open', () => {
      this.streamFailures = 0;
      this.emit('connection', 'live');
    });
    es.addEventListener('message', (e) => this.onStreamMessage((e as MessageEvent<string>).data));
    es.addEventListener('typing', (e) => this.parse<{ typing: boolean; name: string | null }>((e as MessageEvent<string>).data, (d) => this.emit('typing', d)));
    es.addEventListener('read', (e) =>
      this.parse<{ seq: number }>((e as MessageEvent<string>).data, (d) => {
        this.messagesList = applyAgentRead(this.messagesList, d.seq);
        this.emit('read', d);
        this.emit('messages', this.messagesList);
      }),
    );
    es.addEventListener('conversation', (e) =>
      this.parse<Partial<ChatConversation>>((e as MessageEvent<string>).data, (d) => {
        if (this.conv) this.setConversation({ ...this.conv, ...d });
      }),
    );
    es.addEventListener('error', () => {
      // Tarayıcı EventSource kendisi yeniden bağlanır; art arda hatada yoklamaya geçilir.
      this.streamFailures++;
      if (this.streamFailures >= 3) {
        es.close();
        this.source = null;
        this.schedulePoll();
      }
    });
  }

  private parse<T>(raw: string, fn: (data: T) => void): void {
    try {
      fn(JSON.parse(raw) as T);
    } catch {
      // Bozuk olay atlanır.
    }
  }

  private onStreamMessage(raw: string): void {
    this.parse<ChatMessage>(raw, (m) => {
      // Sayaç `messages` olayından önce artar: dinleyiciler (widget okundu işareti, rozet) güncel değeri görür.
      if (m.sender !== 'visitor') this.setUnread(this.unreadCount + 1);
      this.ingest([m]);
      if (m.sender !== 'visitor') {
        this.emit('typing', { typing: false, name: m.author_name });
        // Teslim alındı işaretçisi (okundu widget görünürken ayrıca gönderilir).
        void this.deps.api()?.request('POST', '/chat/ack', { ...this.auth(), delivered_seq: m.seq }).catch(() => undefined);
      }
    });
  }

  private schedulePoll(): void {
    if (!this.connected) return;
    this.emit('connection', 'polling');
    this.pollTimer = setTimeout(() => {
      void (async () => {
        try {
          const before = this.conv?.id;
          await this.refresh();
          if (this.conv) await this.catchUp();
          // Konuşma yeni açıldıysa ve akış destekleniyorsa yeniden denenir.
          if (!before && this.conv && this.streamFailures < 3) {
            this.open();
            return;
          }
        } catch (err) {
          this.deps.logger.debug('sohbet yoklaması başarısız', err);
        }
        this.schedulePoll();
      })();
    }, this.deps.pollMs ?? POLL_MS);
  }

  /** Kimlik değişince (login/logout) ziyaretçi bağlaması yenilenir. */
  onIdentityChanged(): void {
    if (!this.deps.api() || !this.deps.allowed()) return;
    void this.identify();
  }
}

// ---------------------------------------------------------------- widget sözleşmesi

/** Widget seçenekleri (`Pushizo.Chat.show`). Renk/konum/tema verilmezse app ayarı (`chat/config`) kullanılır. */
export interface ChatWidgetOptions {
  /** Widget paketinin adresi; varsayılan `<api>/sdk-web/PushizoChatWidget.js`. */
  widgetUrl?: string;
  /** CSP `script-src` nonce'u (tembel yüklenen widget betiği için). */
  nonce?: string;
  /** Paketi betik etiketi yerine doğrudan vermek için (`import { mountChatWidget } from '@pushizo/web/chat-widget'`). */
  mount?: ChatWidgetModule['mount'];
  /** Başlatıcı düğme gösterilmesin (sohbet `Pushizo.Chat.open()` ile açılır). */
  hideLauncher?: boolean;
  /** Açılışta sohbet penceresini aç. */
  open?: boolean;
  color?: string;
  position?: 'right' | 'left';
  theme?: 'light' | 'dark' | 'auto';
  /** Widget'ın ekleneceği öğe (varsayılan `document.body`). */
  container?: HTMLElement;
  /** Kullanıcı adı/e-postası biliniyorsa formda sorulmaz. */
  name?: string;
  email?: string;
}

export interface ChatWidgetHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface ChatWidgetMountOptions extends ChatWidgetOptions {
  config: ChatConfig;
  language: string;
}

export interface ChatWidgetModule {
  mount(client: ChatClient, options: ChatWidgetMountOptions): ChatWidgetHandle;
}

/** Widget betiğini tembel yükler (`window.PushizoChatWidget`); aynı adres için tek yükleme. */
export function loadChatWidget(url: string, nonce?: string): Promise<ChatWidgetModule> {
  const w = globalThis as unknown as { PushizoChatWidget?: ChatWidgetModule; __hsChatWidgetLoad?: Promise<ChatWidgetModule> };
  if (w.PushizoChatWidget) return Promise.resolve(w.PushizoChatWidget);
  if (w.__hsChatWidgetLoad) return w.__hsChatWidgetLoad;
  w.__hsChatWidgetLoad = new Promise<ChatWidgetModule>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    if (nonce) script.nonce = nonce;
    script.onload = () => (w.PushizoChatWidget ? resolve(w.PushizoChatWidget) : reject(new Error('Sohbet widget paketi yüklenemedi.')));
    script.onerror = () => {
      w.__hsChatWidgetLoad = undefined;
      reject(new Error(`Sohbet widget paketi yüklenemedi: ${url}`));
    };
    document.head.appendChild(script);
  });
  return w.__hsChatWidgetLoad;
}
