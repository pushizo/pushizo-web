import type { AttributionOptions, AttributionState, AttributionTouch, ClickIdType } from './types.js';

/**
 * Birleşik atribüsyon (v3 Faz 23): UTM ve reklam tıklama kimliği yakalamanın DOM'suz saf mantığı.
 * Tarayıcı değerleri (`location`, `document.referrer`) çağıran tarafından verilir.
 */

/** Tıklama kimliği parametreleri; birden çoksa bu öncelik sırasıyla ilki alınır. */
export const CLICK_ID_TYPES: readonly ClickIdType[] = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'li_fat_id', 'msclkid'];
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'] as const;
const DAY_MS = 86_400_000;
/** Aynı parametrelerle bu süre içindeki yeniden yükleme yeni dokunuş sayılmaz. */
export const REPEAT_WINDOW_MS = 30 * 60_000;

export type TouchParams = Omit<AttributionTouch, 'touch_id' | 'occurred_at' | 'landing_url' | 'referrer'>;

export interface ResolvedAttributionOptions {
  enabled: boolean;
  windowMs: number;
  captureClickIds: boolean;
}

export function resolveAttributionOptions(options: AttributionOptions | undefined): ResolvedAttributionOptions {
  const days = options?.windowDays;
  return {
    enabled: options?.enabled !== false,
    windowMs: (typeof days === 'number' && Number.isFinite(days) ? Math.min(90, Math.max(1, days)) : 30) * DAY_MS,
    captureClickIds: options?.captureClickIds !== false,
  };
}

const clip = (value: string | null, max: number): string | undefined => value?.trim().slice(0, max) || undefined;

/** Sorgu dizesindeki UTM ve (açıksa) tıklama kimliği; hiçbiri yoksa null. */
export function touchParams(search: string, captureClickIds: boolean): TouchParams | null {
  const query = new URLSearchParams(search);
  const params: TouchParams = {};
  for (const key of UTM_KEYS) {
    const value = clip(query.get(key), 200);
    if (value) params[key] = value;
  }
  if (captureClickIds)
    for (const type of CLICK_ID_TYPES) {
      const value = clip(query.get(type), 500);
      if (value) {
        params.click_id_type = type;
        params.click_id = value;
        break;
      }
    }
  return Object.keys(params).length > 0 ? params : null;
}

/** Açılış sayfası: yalnızca origin + yol (sorgu ve hash kişisel veri taşıyabilir). */
export function landingUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.origin === 'null' ? undefined : (url.origin + url.pathname).slice(0, 2000);
  } catch {
    return undefined;
  }
}

/** Yönlendirenin host'u; sitenin kendi host'uysa (iç gezinme) veya geçersizse undefined. */
export function referrerHost(referrer: string, ownHost: string): string | undefined {
  try {
    const host = new URL(referrer).host;
    return host && host !== ownHost ? host.slice(0, 255) : undefined;
  } catch {
    return undefined;
  }
}

const age = (touch: AttributionTouch, now: number): number => now - Date.parse(touch.occurred_at);

/** Dokunuş saklama penceresi içinde mi (bozuk tarih: hayır). */
export function withinWindow(touch: AttributionTouch | null | undefined, now: number, windowMs: number): touch is AttributionTouch {
  return !!touch && age(touch, now) <= windowMs;
}

/** Pencere dışına düşen ilk/son dokunuş atılır. */
export function pruneAttribution(state: AttributionState | null | undefined, now: number, windowMs: number): AttributionState {
  return {
    first: withinWindow(state?.first, now, windowMs) ? state.first : null,
    last: withinWindow(state?.last, now, windowMs) ? state.last : null,
  };
}

const signature = (touch: TouchParams): string =>
  [...UTM_KEYS, 'click_id_type' as const, 'click_id' as const].map((key) => touch[key] ?? '').join('\n');

/** Son dokunuşla aynı parametre kümesi ve 30 dakikadan yeni mi (sayfa yenileme). */
export function isRepeatTouch(last: AttributionTouch | null, params: TouchParams, now: number): boolean {
  return !!last && signature(last) === signature(params) && age(last, now) < REPEAT_WINDOW_MS;
}

export interface CaptureInput {
  search: string;
  href: string;
  referrer: string;
  ownHost: string;
  now: number;
  touchId: string;
  state: AttributionState | null | undefined;
  options: ResolvedAttributionOptions;
}

/** Sayfa yüklemesinden dokunuş üretir: ilk dokunuş korunur, son dokunuş güncellenir. Dokunuş yoksa/tekrarsa null. */
export function captureTouch(input: CaptureInput): { touch: AttributionTouch; state: AttributionState } | null {
  if (!input.options.enabled) return null;
  const params = touchParams(input.search, input.options.captureClickIds);
  if (!params) return null;
  const current = pruneAttribution(input.state, input.now, input.options.windowMs);
  if (isRepeatTouch(current.last, params, input.now)) return null;
  const landing = landingUrl(input.href);
  const referrer = referrerHost(input.referrer, input.ownHost);
  const touch: AttributionTouch = {
    touch_id: input.touchId,
    occurred_at: new Date(input.now).toISOString(),
    ...params,
    ...(landing ? { landing_url: landing } : {}),
    ...(referrer ? { referrer } : {}),
  };
  return { touch, state: { first: current.first ?? touch, last: touch } };
}
