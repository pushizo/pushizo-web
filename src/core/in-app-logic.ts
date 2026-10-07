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
      default:
        return false;
    }
  });
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

/** Uygun mesajlar arasından gösterilecek olan: önce `priority` (yüksek), eşitlikte listedeki sıra. */
export function pickMessage(
  messages: InAppMessage[],
  ctx: TriggerContext,
  local: Readonly<Record<string, InAppLocalRecord>>,
  now: number,
): InAppMessage | null {
  let best: InAppMessage | null = null;
  for (const m of messages) {
    if (!triggersMatch(m.triggers, ctx) || !frequencyAllows(m, local[m.id], now)) continue;
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
