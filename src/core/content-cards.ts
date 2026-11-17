import { fetchContentCards, sendContentCardEvent, type InboxAuth, type SdkApi, type SdkContentCard } from './api.js';
import type { ContentCard, ContentCardFeed } from './types.js';

/** API kartını SDK biçimine (camelCase) çevirir (ADR-0082). */
export function toContentCard(card: SdkContentCard): ContentCard {
  return {
    id: card.id,
    messageId: card.message_id,
    type: card.type === 'captioned_image' || card.type === 'image_only' ? card.type : 'classic',
    title: card.title,
    body: card.body,
    url: card.url,
    imageUrl: card.image_url,
    buttonText: card.button_text,
    data: card.data ?? {},
    pinned: card.pinned === true,
    priority: card.priority ?? 0,
    viewed: card.viewed === true,
    clicked: card.clicked === true,
    expiresAt: card.expires_at,
    createdAt: card.created_at,
  };
}

/** Kart akışı (`limit` 1-100 tam sayı; aralık dışı tüm platformlarda olduğu gibi hata fırlatır). */
export async function listContentCards(api: SdkApi, auth: InboxAuth, limit?: number): Promise<ContentCardFeed> {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    throw new Error('Pushizo.ContentCards: limit 1-100 arasında tam sayı olmalı.');
  const res = await fetchContentCards(api, auth, limit);
  return { cards: res.data.map(toContentCard), unviewedCount: res.unviewed_count };
}

export async function contentCardEvent(api: SdkApi, auth: InboxAuth, cardId: string, event: 'impression' | 'click' | 'dismiss'): Promise<ContentCard> {
  if (!cardId) throw new Error('Pushizo.ContentCards: kart kimliği gerekli.');
  return toContentCard(await sendContentCardEvent(api, auth, cardId, event));
}

/** Hazır kart görünümünün kullandığı veri kaynağı (`Pushizo.ContentCards` ile aynı imzalar). */
export interface ContentCardsSource {
  list: (limit?: number) => Promise<ContentCardFeed>;
  logImpression: (cardId: string) => Promise<ContentCard>;
  logClick: (cardId: string) => Promise<ContentCard>;
  dismiss: (cardId: string) => Promise<ContentCard>;
}

export interface ContentCardsViewOptions {
  /** Bir yüklemede istenen kart sayısı (1-100; varsayılan 50). */
  limit?: number;
  theme?: 'light' | 'dark' | 'auto';
  /** Vurgu rengi (`#rrggbb`). */
  color?: string;
  /** Kart bağlantısı yeni sekmede açılsın. */
  newTab?: boolean;
  /** Kart tıklandığında; `true` dönerse SDK bağlantıyı açmaz (yönlendirmeyi site yapar). Tıklama her durumda kaydedilir. */
  onCardClick?: (card: ContentCard) => boolean | void;
  /** Akış her yüklendiğinde (rozet vb. için görülmemiş kart sayısıyla). */
  onFeedLoaded?: (feed: ContentCardFeed) => void;
  /** Görünüm betiğinin adresi (varsayılan `<api>/sdk-web/PushizoContentCards.js`). */
  widgetUrl?: string;
  /** CSP `nonce` değeri (betik etiketi için). */
  nonce?: string;
  /** Paketleyici kullanımı: `import { mountContentCards } from '@pushizo/web/content-cards'` (harici betik yüklenmez). */
  mount?: ContentCardsModule['mount'];
}

export interface ContentCardsViewHandle {
  /** Akışı yeniden yükler. */
  refresh(): Promise<void>;
  /** Görünümü kaldırır ve gözlemcileri temizler. */
  destroy(): void;
}

export interface ContentCardsMountOptions extends ContentCardsViewOptions {
  language: string;
  dir: 'ltr' | 'rtl';
  /** tr/en dışındaki dilin metinleri (ADR-0084; SDK yüklediği katalogdan aktarır). */
  strings?: Record<string, string>;
}

export interface ContentCardsModule {
  mount: (source: ContentCardsSource, target: Element, options: ContentCardsMountOptions) => ContentCardsViewHandle;
}

/** Görünüm betiğini tembel yükler (`window.PushizoContentCards`); aynı sayfada tek yükleme. */
export function loadContentCardsWidget(url: string, nonce?: string): Promise<ContentCardsModule> {
  const w = globalThis as unknown as { PushizoContentCards?: ContentCardsModule; __hsCardsLoad?: Promise<ContentCardsModule> };
  if (w.PushizoContentCards) return Promise.resolve(w.PushizoContentCards);
  return (w.__hsCardsLoad ??= new Promise<ContentCardsModule>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    if (nonce) script.nonce = nonce;
    const fail = () => {
      w.__hsCardsLoad = undefined;
      reject(new Error(`İçerik kartı paketi yüklenemedi: ${url}`));
    };
    script.onload = () => (w.PushizoContentCards ? resolve(w.PushizoContentCards) : fail());
    script.onerror = fail;
    document.head.appendChild(script);
  }));
}
