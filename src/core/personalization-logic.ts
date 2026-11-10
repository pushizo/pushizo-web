/**
 * Web kişiselleştirme (ADR-0083) için saf karar mantığı: uygun deneyimler, varyant seçimi, güvenli adres ve hedef
 * eşleşmesi. DOM'a dokunmaz (birim testlenebilir); koşul/hedefleme web kampanyası mantığıyla ortaktır.
 */
import type { PersonalizationChange, PersonalizationGoal, WebPersonalization } from './types.js';
import { chooseVariant, matchConditions, matchUrlRule, targetingMatches, type DeviceKind, type PageInfo } from './web-campaign-logic.js';

/** Yalnız `http(s)://` ya da `/yol` (`//` değil) uygulanır; `javascript:`, `data:` vb. reddedilir. */
export function safeUrl(url: string | null): string | null {
  return url && /^(?:https?:\/\/[^\s<>"']+|\/(?!\/)[^\s<>"']*)$/i.test(url) ? url : null;
}

/** Sayfada uygulanacak deneyimler (öncelik sırasıyla). */
export function eligiblePersonalizations(list: WebPersonalization[], page: PageInfo, device: DeviceKind, now: number): WebPersonalization[] {
  return list
    .filter((p) => (!p.end_at || Date.parse(p.end_at) > now) && matchConditions(p.conditions, page) && targetingMatches(p.targeting, page.visits, device))
    .sort((a, b) => b.priority - a.priority);
}

/** Ziyaretçinin gördüğü değişiklikler ve raporlanacak varyant (kontrol grubunda değişiklik boştur). */
export function resolvePersonalization(p: WebPersonalization, visitorId: string): { variantId: string | null; changes: PersonalizationChange[] } {
  const v = chooseVariant(p.variants, visitorId, p.id);
  return v ? { variantId: v.id, changes: v.changes } : { variantId: p.winner_variant_id, changes: p.changes };
}

/** Sayfa hedefi bu adreste sağlanıyor mu. */
export function pageGoalMatches(goal: PersonalizationGoal | null, path: string, href: string): boolean {
  return goal?.type === 'page' && matchUrlRule(goal.url, path, href);
}
