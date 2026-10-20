/**
 * Web kampanyaları (ADR-0039) için saf karar mantığı: sayfa/UTM/ziyaret koşulları, cihaz ve ziyaretçi hedeflemesi,
 * sıklık sınırı ve A/B varyant seçimi. DOM'a dokunmaz (birim testlenebilir).
 */
import type { WebCampaign, WebCampaignConditions, WebCampaignFrequency } from './types.js';

export type DeviceKind = 'desktop' | 'mobile' | 'tablet';

/** Kalıcı ziyaretçi durumu (localStorage): kimlik, ziyaret sayısı ve kampanya başına gösterim geçmişi. */
export interface VisitorState {
  id: string;
  visits: number;
  /** Kampanya → toplam gösterim, gün (YYYY-MM-DD) ve o günkü gösterim, son kapatma, dönüşüm. */
  c: Record<string, { n: number; d: string; dn: number; x?: number; v?: 1 }>;
}

/** Oturum durumu (sessionStorage): ilk sayfanın UTM değerleri ve oturumdaki gösterimler. */
export interface SessionState {
  utm: Record<string, string>;
  shown: Record<string, number>;
}

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

/** `*` joker karakterli kalıp (yalnızca joker; diğer karakterler birebir) — regex enjeksiyonu yok. */
export function globMatch(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      if (!value.startsWith(part)) return false;
      pos = part.length;
    } else if (i === parts.length - 1) {
      return value.length - part.length >= pos && value.endsWith(part);
    } else {
      const at = value.indexOf(part, pos);
      if (at < 0) return false;
      pos = at + part.length;
    }
  }
  return true;
}

/** URL kuralı sayfa adresine (yol + sorgu; tam adres de denenir) uyuyor mu. */
export function matchUrlRule(rule: { op: string; value: string }, path: string, href: string): boolean {
  const v = rule.value;
  const test = (s: string) => {
    switch (rule.op) {
      case 'equals':
        return s === v;
      case 'contains':
      case 'not_contains':
        return s.includes(v);
      case 'starts_with':
        return s.startsWith(v);
      case 'matches':
        return globMatch(v, s);
      default:
        return false;
    }
  };
  const hit = test(path) || test(href);
  return rule.op === 'not_contains' ? !hit : hit;
}

export interface PageInfo {
  path: string;
  href: string;
  utm: Record<string, string>;
  visits: number;
}

/** Koşullar: URL kuralları (dahil edenlerden biri VE dışlayanların hepsi), UTM kuralları ve ziyaret sayısı. */
export function matchConditions(c: WebCampaignConditions, page: PageInfo): boolean {
  const rules = c.url_rules ?? [];
  const include = rules.filter((r) => r.op !== 'not_contains');
  const exclude = rules.filter((r) => r.op === 'not_contains');
  if (include.length && !include.some((r) => matchUrlRule(r, page.path, page.href))) return false;
  if (!exclude.every((r) => matchUrlRule(r, page.path, page.href))) return false;
  for (const r of c.utm_rules ?? []) {
    const value = page.utm[r.param];
    if (r.op === 'exists' ? !value : !value || (r.op === 'equals' ? value !== (r.value ?? '') : !value.includes(r.value ?? ''))) return false;
  }
  if (c.visits) {
    const n = page.visits;
    if (c.visits.op === 'gte' ? n < c.visits.value : c.visits.op === 'lte' ? n > c.visits.value : n !== c.visits.value) return false;
  }
  return true;
}

/** Cihaz türü: kullanıcı aracısı + ekran genişliği. */
export function deviceKind(ua: string, width: number): DeviceKind {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(ua) || width < 640) return 'mobile';
  return 'desktop';
}

/** Ziyaretçi ve cihaz hedeflemesi (segment hedeflemesi sunucuda uygulanmıştır). */
export function targetingMatches(t: WebCampaign['targeting'], visits: number, device: DeviceKind): boolean {
  if (t.visitor === 'new' && visits > 1) return false;
  if (t.visitor === 'returning' && visits < 2) return false;
  return t.devices.length === 0 || t.devices.includes(device);
}

export const today = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Sıklık sınırı: oturum, gün, toplam, kapatma sonrası bekleme ve dönüşüm sonrası durdurma. */
export function frequencyAllows(f: WebCampaignFrequency, id: string, visitor: VisitorState, session: SessionState, now: number): boolean {
  const h = visitor.c[id];
  if (f.max_per_session !== undefined && (session.shown[id] ?? 0) >= f.max_per_session) return false;
  if (!h) return true;
  if (f.stop_after_conversion !== false && h.v) return false;
  if (f.max_total !== undefined && h.n >= f.max_total) return false;
  if (f.max_per_day !== undefined && h.d === today(now) && h.dn >= f.max_per_day) return false;
  if (f.hide_after_close_days && h.x && now - h.x < f.hide_after_close_days * 86_400_000) return false;
  return true;
}

/** Gösterimi ziyaretçi ve oturum durumuna işler. */
export function recordShown(id: string, visitor: VisitorState, session: SessionState, now: number): void {
  const d = today(now);
  const h = visitor.c[id] ?? { n: 0, d, dn: 0 };
  h.n++;
  h.dn = h.d === d ? h.dn + 1 : 1;
  h.d = d;
  visitor.c[id] = h;
  session.shown[id] = (session.shown[id] ?? 0) + 1;
}

/** FNV-1a 32 bit (deterministik kova). */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A/B: ziyaretçi + kampanya kimliğinden deterministik varyant (aynı ziyaretçi hep aynı görünümü görür). */
export function chooseVariant<T extends { weight_percent: number }>(variants: T[], visitorId: string, campaignId: string): T | null {
  if (!variants.length) return null;
  const bucket = fnv1a(`${visitorId}:${campaignId}`) % 100;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight_percent;
    if (bucket < acc) return v;
  }
  return variants[variants.length - 1]!;
}

/** URL'nin UTM parametreleri. */
export function utmOf(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}
