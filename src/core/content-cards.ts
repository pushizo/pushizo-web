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
