import type { HsButton, HsPayloadMeta, WebPushPayload } from '../core/types.js';

/** Teslimat kimliği: yeni `hs.dlv`, yoksa eski `hs.delivery_id`. */
export function deliveryIdOf(hs: HsPayloadMeta | null | undefined): string | undefined {
  const value = hs?.dlv ?? hs?.delivery_id;
  return typeof value === 'string' && value ? value : undefined;
}

/** Mesaj kimliği (`hs.msg`, eski `hs.message_id`). */
export function messageIdOf(hs: HsPayloadMeta | null | undefined): string | undefined {
  const value = hs?.msg ?? hs?.message_id;
  return typeof value === 'string' && value ? value : undefined;
}

function parseButtons(raw: unknown): HsButton[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>[])
    .filter((b) => b && typeof b.id === 'string' && typeof b.title === 'string')
    .map((b) => ({
      id: b.id as string,
      title: b.title as string,
      url: typeof b.url === 'string' ? b.url : undefined,
      icon: typeof b.icon === 'string' ? b.icon : undefined,
    }));
}

/** Metin bir JSON nesnesi mi (SW hata raporu: bozuk payload tespiti). */
export function isJsonObjectText(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Push gövdesini güvenli biçimde ayrıştırır; JSON değilse metni gövde olarak kullanır. */
export function parsePushPayload(raw: string | null | undefined): WebPushPayload {
  if (!raw) return { title: '', body: '' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      const hs: HsPayloadMeta | undefined = p.hs && typeof p.hs === 'object' ? { ...(p.hs as HsPayloadMeta) } : undefined;
      const buttons = parseButtons(hs?.buttons);
      if (hs && buttons) hs.buttons = buttons;
      // Üst düzey `actions` yoksa `hs.buttons` aksiyonlara dönüştürülür.
      const rawActions: Record<string, unknown>[] | undefined = Array.isArray(p.actions)
        ? (p.actions as Record<string, unknown>[])
        : buttons?.map((b) => ({ action: b.id, title: b.title, icon: b.icon, url: b.url }));
      return {
        title: typeof p.title === 'string' ? p.title : '',
        body: typeof p.body === 'string' ? p.body : '',
        icon: typeof p.icon === 'string' ? p.icon : undefined,
        image: typeof p.image === 'string' ? p.image : undefined,
        badge: typeof p.badge === 'string' ? p.badge : undefined,
        url: typeof p.url === 'string' ? p.url : typeof hs?.url === 'string' ? hs.url : undefined,
        tag: typeof p.tag === 'string' ? p.tag : undefined,
        requireInteraction: p.requireInteraction === true,
        actions: rawActions
          ? rawActions
              .filter((a) => typeof a.action === 'string' && typeof a.title === 'string')
              .slice(0, 2)
              .map((a) => ({ action: a.action as string, title: a.title as string, icon: typeof a.icon === 'string' ? a.icon : undefined, url: typeof a.url === 'string' ? a.url : undefined }))
          : undefined,
        data: p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : undefined,
        hs,
      };
    }
  } catch {
    // düz metin
  }
  return { title: '', body: raw };
}

/** `showNotification` seçenekleri; `data` içinde tıklama anında gereken her şey taşınır. */
export function toNotificationOptions(payload: WebPushPayload): { title: string; options: NotificationOptions & { actions?: { action: string; title: string; icon?: string }[] } } {
  const title = payload.title || payload.body || 'HeroSignal';
  return {
    title,
    options: {
      body: payload.title ? payload.body : undefined,
      icon: payload.icon,
      image: payload.image,
      badge: payload.badge,
      tag: payload.tag,
      requireInteraction: payload.requireInteraction,
      actions: payload.actions?.map((a) => ({ action: a.action, title: a.title, icon: a.icon })),
      data: { hs: payload.hs ?? {}, url: payload.url, actions: payload.actions ?? [], title: payload.title ?? '', body: payload.body ?? '', custom: payload.data ?? {} },
    } as NotificationOptions & { image?: string; actions?: { action: string; title: string; icon?: string }[] },
  };
}

/** Tıklama hedefi: buton URL'si > bildirim URL'si. */
export function resolveClickUrl(data: { url?: string; actions?: { action: string; url?: string }[] }, actionId: string | undefined): string | undefined {
  if (actionId) {
    const action = data.actions?.find((a) => a.action === actionId);
    if (action?.url) return action.url;
  }
  return data.url;
}

/**
 * Tıklamada kullanılacak açık sekme (eski sağlayıcı `notificationClickHandlerMatch`/`Action`).
 * `exact`: URL'si hedefle birebir aynı sekme öne getirilir (gezinme gerekmez). `origin`: hedefle aynı origin'deki
 * ilk sekme kullanılır; `navigate` ise sekme hedefe götürülür, `focus` ise yalnızca öne getirilir.
 * Eşleşme yoksa null (yeni pencere açılır).
 */
export function pickClickTarget(
  clientUrls: readonly string[],
  url: string,
  match: string | null | undefined,
  action: string | null | undefined,
): { index: number; navigate: boolean } | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const parsed = clientUrls.map((u) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  });
  const exact = parsed.findIndex((u) => u?.href === target.href);
  if (match !== 'origin') return exact >= 0 ? { index: exact, navigate: false } : null;
  if (exact >= 0) return { index: exact, navigate: false };
  const index = parsed.findIndex((u) => u?.origin === target.origin);
  if (index < 0) return null;
  return { index, navigate: action !== 'focus' };
}

/**
 * Bildirim tıklamasında açılabilecek güvenli adres: yalnızca `http:`/`https:` mutlak adresler veya aynı
 * origin'e çözülen göreli adresler kabul edilir. `javascript:`, `data:`, `vbscript:` gibi şemalar ve başka
 * origin'e çıkan göreli adresler (`//evil.example`, `/\evil.example`) reddedilir (undefined).
 */
export function safeClickUrl(raw: string | null | undefined, origin: string): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let base: URL;
  let parsed: URL;
  try {
    base = new URL(origin);
    parsed = new URL(raw.trim(), base);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  // Şema içermeyen adres göreli sayılır ve yalnızca aynı origin'de kalabilir.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw.trim());
  if (!absolute && parsed.origin !== base.origin) return undefined;
  return parsed.href;
}

/** Teslimat geri bildirimi yeniden deneme beklemeleri (ms); toplam 3 deneme. */
export const FEEDBACK_BACKOFF_MS = [500, 1500];

/** Geri bildirim gönderim sonucu: gönderildi, kalıcı ret (4xx) veya sonra yeniden denenmeli. */
export type FeedbackResult = 'sent' | 'rejected' | 'retry';

/**
 * POST isteğini ağ hatası, 429 veya 5xx durumunda `backoff` beklemeleriyle yeniden dener.
 * 4xx kalıcı hatadır, tekrarlanmaz. Hata fırlatmaz.
 */
export async function deliverFeedback(
  send: (init: RequestInit) => Promise<Response>,
  body?: unknown,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  backoff: readonly number[] = FEEDBACK_BACKOFF_MS,
): Promise<FeedbackResult> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'omit',
    keepalive: true,
  };
  for (let attempt = 0; ; attempt++) {
    let retryable: boolean;
    try {
      const res = await send(init);
      if (res.ok) return 'sent';
      retryable = res.status === 429 || res.status >= 500;
    } catch {
      // Ağ hatası: yeniden denenebilir.
      retryable = true;
    }
    if (!retryable) return 'rejected';
    if (attempt >= backoff.length) return 'retry';
    await sleep(backoff[attempt]!);
  }
}

/**
 * POST isteğini ağ hatası, 429 veya 5xx durumunda geri çekilmeyle yeniden dener (en fazla 3 deneme).
 * 4xx kalıcı hatadır, tekrarlanmaz. Hata fırlatmaz: geri bildirim gösterimi engellememelidir.
 * @returns İstek başarılı olduysa true.
 */
export async function postWithRetry(
  send: (init: RequestInit) => Promise<Response>,
  body?: unknown,
  sleep?: (ms: number) => Promise<void>,
): Promise<boolean> {
  return (await deliverFeedback(send, body, sleep)) === 'sent';
}
