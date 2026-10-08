import type { InAppLocalRecord, InAppMessage, InAppTrigger, InAppTriggerValue } from './types.js';

/**
 * Değerlendirme bağlamı: neden (anlık olay) + kalıcı durum.
 * `session_start` ve `event` koşulları anlıktır (yalnızca o olay anında sağlanır);
 * `screen` (geçerli ekran) ve `trigger` (addTrigger değerleri) durum koşullarıdır.
 */
export interface TriggerContext {
  /** Oturum başlangıcı değerlendirmesi mi. */
  sessionStart: boolean;
  /** Değerlendirmeyi başlatan olay adı (`Session.sendEvent`). */
  eventName?: string;
  /** Geçerli ekran (`InAppMessages.setScreen`). */
  screen: string | null;
  triggers: Readonly<Record<string, InAppTriggerValue>>;
  /** Geçerli oturumun süresi (saniye); `session_duration` koşulları için. Oturum yoksa 0. */
  sessionElapsedSeconds?: number;
}

/** App geneli gösterim aralığı (ADR-0019 §7): herhangi bir mesajın son gösteriminden beri geçmesi gereken süre. */
export interface GlobalInterval {
  minIntervalSeconds: number;
  /** Herhangi bir in-app mesajın son gösterim anı (epoch ms); yoksa null. */
  lastImpressionAt: number | null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** İki değer eşit mi: ikisi de sayıya çevrilebiliyorsa sayısal, değilse metin karşılaştırması. */
function looselyEqual(actual: InAppTriggerValue, expected: string | number | undefined): boolean {
  if (expected === undefined) return false;
  const a = asNumber(actual);
  const b = asNumber(expected);
  if (a !== null && b !== null) return a === b;
  return String(actual) === String(expected);
}

/** Tek bir `trigger` koşulu (eq | neq | exists | gt | lt). */
export function matchesTriggerCondition(
  condition: Extract<InAppTrigger, { kind: 'trigger' }>,
  values: Readonly<Record<string, InAppTriggerValue>>,
): boolean {
  const present = Object.prototype.hasOwnProperty.call(values, condition.key);
  const actual = present ? values[condition.key] : undefined;
  switch (condition.op) {
    case 'exists':
      return present;
    case 'eq':
      return actual !== undefined && looselyEqual(actual, condition.value);
    case 'neq':
      // Tanımsız anahtar "eşit değil" sayılır.
      return actual === undefined || !looselyEqual(actual, condition.value);
    case 'gt':
    case 'lt': {
      const a = asNumber(actual);
      const b = asNumber(condition.value);
      if (a === null || b === null) return false;
      return condition.op === 'gt' ? a > b : a < b;
    }
    default:
      return false;
  }
}

/** Mesajın tüm tetik koşulları bu bağlamda sağlanıyor mu (koşulsuz mesaj her değerlendirmede uygundur). */
export function triggersMatch(triggers: InAppTrigger[], ctx: TriggerContext): boolean {
  return triggers.every((t) => {
    switch (t.kind) {
      case 'session_start':
        return ctx.sessionStart;
      case 'event':
        return ctx.eventName !== undefined && ctx.eventName === t.name;
      case 'screen':
        return ctx.screen !== null && ctx.screen === t.name;
      case 'trigger':
        return matchesTriggerCondition(t, ctx.triggers);
      case 'session_duration':
        return (ctx.sessionElapsedSeconds ?? 0) >= t.seconds;
      default:
        return false;
    }
  });
}

/** Mesajın tetik grupları: `trigger_groups` varsa o, yoksa geriye uyum için `[triggers]`. */
export function triggerGroupsOf(message: Pick<InAppMessage, 'triggers' | 'trigger_groups'>): InAppTrigger[][] {
  const groups = message.trigger_groups;
  if (Array.isArray(groups) && groups.length > 0) return groups.filter((g) => Array.isArray(g));
  return [Array.isArray(message.triggers) ? message.triggers : []];
}

/** Gruplar VEYA ile bağlıdır: herhangi bir grubun tüm koşulları sağlanıyorsa mesaj uygundur. */
export function triggerGroupsMatch(groups: InAppTrigger[][], ctx: TriggerContext): boolean {
  if (groups.length === 0) return true;
  return groups.some((group) => triggersMatch(group, ctx));
}

/**
 * `session_duration` koşulları için bir sonraki değerlendirmeye kalan süre (saniye): henüz dolmamış
 * en yakın eşik. Böyle bir koşul yoksa null. Hak kalmamış mesajlar yine de sayılır (ucuz; değerlendirme süzer).
 */
export function nextSessionDurationDelay(
  messages: Pick<InAppMessage, 'triggers' | 'trigger_groups'>[],
  elapsedSeconds: number,
): number | null {
  let best: number | null = null;
  for (const m of messages)
    for (const group of triggerGroupsOf(m))
      for (const t of group) {
        if (t.kind !== 'session_duration') continue;
        const remaining = t.seconds - elapsedSeconds;
        if (remaining <= 0) continue;
        if (best === null || remaining < best) best = remaining;
      }
  return best;
}

/** App geneli aralık: son gösterimden beri `minIntervalSeconds` geçmediyse hiçbir mesaj gösterilmez. */
export function globalIntervalAllows(global: GlobalInterval | undefined, now: number): boolean {
  if (!global || global.minIntervalSeconds <= 0 || !global.lastImpressionAt) return true;
  return now - global.lastImpressionAt >= global.minIntervalSeconds * 1000;
}

/**
 * Sıklık kuralları yerelde: sunucunun bildirdiği kalan gösterim hakkından henüz sunucuya ulaşmamış
 * yerel gösterimler düşülür; iki gösterim arası süre sunucu ve yerel son gösterimin en yenisinden ölçülür.
 */
export function frequencyAllows(
  message: InAppMessage,
  local: InAppLocalRecord | undefined,
  now: number,
): boolean {
  if (message.end_at && Date.parse(message.end_at) <= now) return false;
  // Etkileşim sunucuya ulaşmadan da (sonraki liste yenilemesini beklemeden) yerelde durdurulur.
  if (message.stop_after_interaction && local?.interacted) return false;
  const remaining = message.remaining_impressions - (local?.pending ?? 0);
  if (remaining <= 0) return false;
  if (message.min_interval_seconds > 0) {
    const serverLast = message.last_impression_at ? Date.parse(message.last_impression_at) : NaN;
    const last = Math.max(Number.isFinite(serverLast) ? serverLast : 0, local?.lastAt ?? 0);
    if (last > 0 && now - last < message.min_interval_seconds * 1000) return false;
  }
  return true;
}

/**
 * Uygun mesajlar arasından gösterilecek olan: önce `priority` (yüksek), eşitlikte listedeki sıra.
 * App geneli aralık (`global`) dolmadıysa hiçbir mesaj seçilmez.
 */
export function pickMessage(
  messages: InAppMessage[],
  ctx: TriggerContext,
  local: Readonly<Record<string, InAppLocalRecord>>,
  now: number,
  global?: GlobalInterval,
): InAppMessage | null {
  if (!globalIntervalAllows(global, now)) return null;
  let best: InAppMessage | null = null;
  for (const m of messages) {
    if (!triggerGroupsMatch(triggerGroupsOf(m), ctx) || !frequencyAllows(m, local[m.id], now)) continue;
    if (!best || m.priority > best.priority) best = m;
  }
  return best;
}

/** Yalnızca http(s) adresleri; aksi halde null (ör. `javascript:`). */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Betik çalıştırabilen veya yerel kaynağa giden şemalar deeplink olarak kabul edilmez. */
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about']);

/** Uygulama şeması (`myapp://…`) veya http(s); tehlikeli şemalar null. */
export function safeDeeplink(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!match) return null;
  return BLOCKED_SCHEMES.has(match[1]!.toLowerCase()) ? null : trimmed;
}

/** Yalnızca #rgb, #rgba, #rrggbb, #rrggbbaa renkleri; diğerleri yok sayılır. */
export function safeColor(value: string | null | undefined): string | null {
  return value && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : null;
}
