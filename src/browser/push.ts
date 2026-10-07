import type { Logger } from '../core/logger.js';
import type { PermissionState, WorkerMessage } from '../core/types.js';

export interface PushManagerOptions {
  appId: string;
  apiUrl: string;
  serviceWorkerPath: string;
  serviceWorkerScope?: string;
  /** SW'ye sorgu parametresi olarak iletilen tıklama davranışı (yalnızca verildiyse; SW URL'si gereksiz değişmez). */
  clickMatch?: 'exact' | 'origin';
  clickAction?: 'navigate' | 'focus';
  logger: Logger;
}

/** base64url VAPID public key → Uint8Array (PushManager.subscribe applicationServerKey). */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isSecureContextOk(allowLocalhost: boolean): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  return allowLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

export function currentPermission(): PermissionState {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

/** Service worker kaydı ve PushManager işlemleri. */
export class WebPushManager {
  private registration: ServiceWorkerRegistration | null = null;
  private readonly listeners = new Set<(message: WorkerMessage, reply: (data: unknown) => void) => void>();

  constructor(private readonly options: PushManagerOptions) {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
        const data = event.data;
        if (!data || typeof data !== 'object' || typeof data.type !== 'string' || !data.type.startsWith('hs:')) return;
        const port = event.ports[0];
        const reply = (payload: unknown) => port?.postMessage(payload);
        for (const listener of this.listeners) listener(data, reply);
      });
    }
  }

  onMessage(listener: (message: WorkerMessage, reply: (data: unknown) => void) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** SW'yi app_id ve API kökü sorgu parametreleriyle kaydeder (worker bunları okur). */
  async register(): Promise<ServiceWorkerRegistration> {
    if (this.registration) return this.registration;
    const url = new URL(this.options.serviceWorkerPath, window.location.origin);
    url.searchParams.set('appId', this.options.appId);
    url.searchParams.set('apiUrl', this.options.apiUrl);
    if (this.options.clickMatch) url.searchParams.set('clickMatch', this.options.clickMatch);
    if (this.options.clickAction) url.searchParams.set('clickAction', this.options.clickAction);
    const registration = await navigator.serviceWorker.register(url.toString(), { scope: this.options.serviceWorkerScope });
    await navigator.serviceWorker.ready;
    this.registration = registration;
    this.options.logger.debug('service worker kaydedildi', registration.scope);
    return registration;
  }

  /** Sayfadan yerel bildirim gösterir (ör. karşılama bildirimi); tıklamayı SW işler. */
  async showLocalNotification(title: string, options: NotificationOptions): Promise<void> {
    const reg = await this.register();
    await reg.showNotification(title, options);
  }

  async getSubscription(): Promise<PushSubscription | null> {
    const reg = await this.register();
    return reg.pushManager.getSubscription();
  }

  async subscribe(vapidPublicKey: string): Promise<PushSubscription> {
    const reg = await this.register();
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      // Farklı VAPID anahtarıyla alınmış abonelik yenilenir.
      const key = existing.options.applicationServerKey;
      if (key && !sameKey(new Uint8Array(key), urlBase64ToUint8Array(vapidPublicKey))) {
        await existing.unsubscribe();
      } else {
        return existing;
      }
    }
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource });
  }

  async unsubscribe(): Promise<boolean> {
    const sub = await this.getSubscription();
    if (!sub) return false;
    return sub.unsubscribe();
  }

  /** SW'nin sayfa kapalıyken kaydettiği abonelik değişikliğini okur ve temizler. */
  async takePendingSubscriptionChange(): Promise<PushSubscriptionJSON | null | undefined> {
    if (!('caches' in window)) return undefined;
    try {
      const cache = await caches.open('hs-sw-config');
      const res = await cache.match('/pending-subscription-change');
      if (!res) return undefined;
      await cache.delete('/pending-subscription-change');
      const data = (await res.json()) as { subscription: PushSubscriptionJSON | null };
      return data.subscription;
    } catch {
      return undefined;
    }
  }
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Push aboneliği JSON'u → HeroSignal token metni (sunucu `{endpoint, keys}` bekler).
 * Endpoint veya şifreleme anahtarları eksikse (gerçek abonelik değil) null döner; boş/sahte token gönderilmez.
 */
export function subscriptionToToken(json: PushSubscriptionJSON | null | undefined): string | null {
  const endpoint = json?.endpoint;
  const p256dh = json?.keys?.p256dh;
  const auth = json?.keys?.auth;
  if (!endpoint || !/^https:\/\//.test(endpoint) || !p256dh || !auth) return null;
  return JSON.stringify({ endpoint, keys: { p256dh, auth } });
}
