/// <reference lib="webworker" />
import { ErrorReporter } from '../core/errors.js';
import type { HsPayloadMeta, WorkerMessage } from '../core/types.js';
import { deliveryIdOf, isJsonObjectText, parsePushPayload, pickClickTarget, postWithRetry, resolveClickUrl, toNotificationOptions } from './payload.js';

declare const self: ServiceWorkerGlobalScope;

/**
 * HeroSignal service worker. Müşteri siteye `HeroSignalSDKWorker.js` olarak yerleştirir veya mevcut
 * SW içinde `importScripts('https://api.example/sdk-web/HeroSignalSDKWorker.js')` ile ekler.
 * API kökü ve app_id, SW kaydı sırasında sorgu parametresi ile verilir (`?appId=…&apiUrl=…`).
 */
const params = new URL(self.location.href).searchParams;
const APP_ID = params.get('appId') ?? '';
const API_URL = (params.get('apiUrl') ?? self.location.origin).replace(/\/$/, '');
/** Tıklama davranışı (init `notificationClickHandlerMatch`/`Action`; varsayılan exact + navigate). */
const CLICK_MATCH = params.get('clickMatch');
const CLICK_ACTION = params.get('clickAction');
const STORE = 'hs-sw-config';
const SDK_VERSION = typeof __HS_SDK_VERSION__ === 'string' ? __HS_SDK_VERSION__ : '0.0.0-dev';

/**
 * SW hata raporları: worker ömrü boyunca en fazla 20, tekrarsız; gönderim hatası yutulur (özyineleme yok).
 * Olay işleyicileri `waitUntil(errors.flush())` ile gönderimi bekletir.
 */
const errors = new ErrorReporter({
  sdkVersion: SDK_VERSION,
  flushDelayMs: 60_000,
  send: async (body) => {
    await fetch(`${API_URL}/sdk/v1/apps/${encodeURIComponent(APP_ID)}/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      keepalive: true,
    });
  },
});

function deliveryUrl(deliveryId: string, action: 'received' | 'opened' | 'dismissed'): string {
  return `${API_URL}/sdk/v1/apps/${encodeURIComponent(APP_ID)}/deliveries/${encodeURIComponent(deliveryId)}/${action}`;
}

/** Teslimat geri bildirimi: ağ/5xx/429 hatalarında geri çekilmeyle en fazla 3 deneme (bkz. postWithRetry). */
async function post(url: string, body?: unknown): Promise<void> {
  await postWithRetry((init) => fetch(url, init), body);
}

interface NotificationData {
  hs?: HsPayloadMeta;
  url?: string;
  actions?: { action: string; url?: string }[];
  title?: string;
  body?: string;
}

async function broadcast(message: WorkerMessage): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const raw = event.data?.text();
  if (raw && !isJsonObjectText(raw)) errors.record('push_parse_failed', 'push gövdesi JSON nesnesi değil', undefined, { level: 'warning' });
  const payload = parsePushPayload(raw);
  const deliveryId = deliveryIdOf(payload.hs);
  const { title, options } = toNotificationOptions(payload);
  event.waitUntil(
    (async () => {
      // Ön plan dinleyicisi gösterimi engelleyebilir; bunun için önce sayfaya haber verilir.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      let prevented = false;
      if (clients.length > 0) {
        const replies = await Promise.all(
          clients.map(
            (client) =>
              new Promise<boolean>((resolve) => {
                const channel = new MessageChannel();
                const timer = setTimeout(() => resolve(false), 300);
                channel.port1.onmessage = (e: MessageEvent<{ preventDefault?: boolean }>) => {
                  clearTimeout(timer);
                  resolve(e.data?.preventDefault === true);
                };
                client.postMessage({ type: 'hs:push-received', payload } satisfies WorkerMessage, [channel.port2]);
              }),
          ),
        );
        prevented = replies.some(Boolean);
      }
      // Gösterim, `received` yeniden denemelerini beklemez.
      await Promise.all([
        prevented
          ? Promise.resolve()
          : self.registration.showNotification(title, options).catch((err: unknown) => {
              errors.record('display_failed', 'bildirim gösterilemedi', err);
            }),
        deliveryId ? post(deliveryUrl(deliveryId, 'received')) : Promise.resolve(),
      ]);
      await errors.flush();
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification.data ?? {}) as NotificationData;
  event.notification.close();
  const actionId = event.action || undefined;
  const url = resolveClickUrl(data, actionId);
  const deliveryId = deliveryIdOf(data.hs);
  event.waitUntil(
    (async () => {
      if (deliveryId) await post(deliveryUrl(deliveryId, 'opened'), actionId ? { button_id: actionId } : {});
      await broadcast({ type: 'hs:notification-click', payload: { title: data.title, body: data.body, url: data.url, actions: data.actions as never, hs: data.hs }, actionId, url });
      if (url) {
        const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) as WindowClient[];
        const pick = pickClickTarget(clients.map((c) => c.url), url, CLICK_MATCH, CLICK_ACTION);
        const client = pick ? clients[pick.index] : undefined;
        if (client) {
          await client.focus();
          // Kapsam dışı sekmede navigate() hata verebilir; o durumda yeni pencere açılır.
          if (pick!.navigate) await client.navigate(url).catch(() => self.clients.openWindow(url));
        } else {
          await self.clients.openWindow(url);
        }
      }
    })(),
  );
});

// Kullanıcı bildirimi kapattı/kaydırdı (tıklamadan): `dismissed` bildirilir.
self.addEventListener('notificationclose', (event) => {
  const data = (event.notification.data ?? {}) as NotificationData;
  const deliveryId = deliveryIdOf(data.hs);
  if (!deliveryId) return;
  event.waitUntil(post(deliveryUrl(deliveryId, 'dismissed')));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  const e = event as PushSubscriptionChangeEvent;
  event.waitUntil(
    (async () => {
      let next: PushSubscription | null = e.newSubscription ?? null;
      if (!next && e.oldSubscription?.options.applicationServerKey) {
        try {
          next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: e.oldSubscription.options.applicationServerKey });
        } catch (err) {
          next = null;
          errors.record('resubscribe_failed', 'abonelik yenilenemedi (pushsubscriptionchange)', err);
        }
      }
      await errors.flush();
      await broadcast({ type: 'hs:subscription-change', subscription: next ? next.toJSON() : null });
      // Sayfa açık değilse SDK bir sonraki açılışta mevcut aboneliği sunucuyla eşitler.
      const cache = await caches.open(STORE);
      await cache.put('/pending-subscription-change', new Response(JSON.stringify({ at: Date.now(), subscription: next ? next.toJSON() : null })));
    })(),
  );
});

interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly newSubscription?: PushSubscription | null;
  readonly oldSubscription?: PushSubscription | null;
}
