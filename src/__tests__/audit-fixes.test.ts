// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/api.js';
import { Logger } from '../core/logger.js';
import { OfflineQueue } from '../core/queue.js';
import { MemoryStore, StateStore } from '../core/storage.js';
import { digest } from '../core/token.js';
import type { PermissionChangeEvent, PersistedState, QueuedOperation } from '../core/types.js';
import { createSdk } from '../sdk.js';

/**
 * Denetim düzeltmeleri (Web SDK): gizlilik onayı (B-9), kuyruk kilitlenmesi (B-10), kimliksiz olaylar (B-16),
 * olay sahiplik kanıtı (D-1) ve §6.1 yüzey eklemeleri (izin gözlemcisi, clearAll, display, removeObserver).
 */

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeApi() {
  const calls: Call[] = [];
  const fetchStub = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace('/sdk/v1/apps/app_1', '');
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const route = `${call.method} ${path}`;
    if (route === 'GET /config')
      return json(200, {
        app_id: 'app_1',
        name: 'Test',
        identity_verification_required: false,
        platforms: { web: true, email: true, sms: true },
        web: { vapid_public_key: null, allowed_origins: [] },
        session: { timeout_seconds: 30 },
      });
    if (route === 'POST /subscriptions')
      return json(200, {
        subscription_id: 'sub_mail',
        user_id: 'usr_1',
        external_id: null,
        status: 'subscribed',
        created: true,
      });
    if (route.startsWith('PATCH /users/')) return json(200, { user_id: 'usr_1', tags: { a: '1' } });
    if (route === 'GET /in-app') return json(200, { language: 'en', data: [] });
    if (route === 'POST /events' || route === 'POST /sessions' || route === 'POST /errors')
      return json(200, { accepted: 1 });
    return json(404, { error: { code: 'HS_NOT_FOUND', message: route } });
  });
  vi.stubGlobal('fetch', fetchStub);
  return {
    calls,
    fetchStub,
    find: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

const stored = () => JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as PersistedState;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const eventsOf = (calls: Call[]) =>
  calls.flatMap((c) => (c.body?.events ?? []) as Record<string, unknown>[]);

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('gizlilik onayı (B-9)', () => {
  it('consent yokken 0 fetch, onaydan sonra kuyruk boşalır', async () => {
    const tokenHash = await digest('push-token');
    // Önceki ziyaretten kalan kimlik: onay verilince işlemler bu kimlikle gönderilebilir.
    localStorage.setItem(
      'hs:app_1',
      JSON.stringify({
        subscriptionId: 'sub_push',
        userId: 'usr_1',
        optedIn: true,
        tokenHash,
        consentGiven: false,
      }),
    );
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({
      appId: 'app_1',
      apiUrl: 'https://api.test',
      logLevel: 'silent',
      requiresPrivacyConsent: true,
    });

    hs.User.addTag('a', '1');
    hs.User.addTags({ b: '2' });
    hs.User.setLanguage('tr');
    hs.User.addAlias('crm_id', '42');
    hs.Session.sendEvent('viewed', { page: 'home' });
    // Toplu olay zamanlayıcısı (1 sn) dahil hiçbir yol ağa çıkmamalı.
    await tick(1200);
    expect(api.fetchStub).not.toHaveBeenCalled();
    await expect(hs.login('u-1')).rejects.toThrow(/onay/);
    expect(api.fetchStub).not.toHaveBeenCalled();
    // İşlemler kalıcı kuyrukta bekler.
    expect(stored().queue.map((op) => op.type)).toEqual([
      'tags',
      'properties',
      'alias_add',
      'event',
    ]);

    await hs.setConsentGiven(true);
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));
    expect(api.find('GET', '/config')).toHaveLength(1);
    expect(api.find('PATCH', '/users/usr_1').map((c) => c.body)).toEqual([
      { tags: { a: '1', b: '2' } },
      { properties: { language: 'tr' } },
    ]);
    expect(api.find('PATCH', '/users/usr_1/identity')[0]!.body).toEqual({
      identity: { crm_id: '42' },
    });
    expect(eventsOf(api.find('POST', '/events'))).toEqual([
      expect.objectContaining({
        name: 'viewed',
        subscription_id: 'sub_push',
        token_hash: tokenHash,
      }),
    ]);
    hs.destroy();
  });

  it('onay geri alınınca kuyruk temizlenir ve yeni işlemler gönderilmez', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({
      appId: 'app_1',
      apiUrl: 'https://api.test',
      logLevel: 'silent',
      requiresPrivacyConsent: true,
    });
    await hs.setConsentGiven(true);
    await vi.waitFor(() => expect(api.find('GET', '/config')).toHaveLength(1));
    await hs.setConsentGiven(false);
    const before = api.fetchStub.mock.calls.length;
    hs.User.addTag('x', '1');
    hs.Session.sendEvent('after_revoke');
    window.dispatchEvent(new Event('online'));
    await tick(1200);
    expect(api.fetchStub.mock.calls.length).toBe(before);
    hs.destroy();
  });
});

describe('kuyruk kilitlenmesi (B-10)', () => {
  const logger = new Logger('silent');

  it('kimlik bekleyen işlemler sırasını korur; kullanıcıyı oluşturan contact_add önce işlenir', async () => {
    const store = new StateStore('app_lock', new MemoryStore());
    let hasUser = false;
    const order: string[] = [];
    const q = new OfflineQueue(
      store,
      async (op) => {
        const name = op.type === 'alias_remove' ? `alias:${op.label}` : op.type;
        if ((op.type === 'tags' || op.type === 'alias_remove') && !hasUser)
          throw new ApiError(0, 'NO_USER', 'kullanıcı yok');
        if (op.type === 'contact_add') hasUser = true;
        order.push(name);
      },
      logger,
    );
    q.enqueue({ type: 'tags', tags: { a: '1' }, at: 1 });
    q.enqueue({ type: 'alias_remove', label: 'old', at: 2 });
    q.enqueue({ type: 'received', deliveryId: 'dlv_1', at: 3 });
    // Kimlik oluşturan işlem yokken: bağımsız işlem gider, kimlik bekleyenler kalır.
    expect(await q.flush()).toBe(false);
    expect(order).toEqual(['received']);
    expect(store.get().queue.map((op) => op.type)).toEqual(['tags', 'alias_remove']);

    q.enqueue({ type: 'contact_add', channel: 'email', token: 'a@example.com', at: 4 });
    expect(await q.flush()).toBe(true);
    expect(order).toEqual(['received', 'contact_add', 'tags', 'alias:old']);
    expect(q.size).toBe(0);
  });

  it('kimlik beklemesi dışındaki geçici hata flush’ı yine durdurur', async () => {
    const store = new StateStore('app_lock2', new MemoryStore());
    const seen: QueuedOperation['type'][] = [];
    const q = new OfflineQueue(
      store,
      async (op) => {
        if (op.type === 'contact_add') throw new ApiError(503, 'HS_SERVICE_UNAVAILABLE', 'x');
        seen.push(op.type);
      },
      logger,
    );
    q.enqueue({ type: 'contact_add', channel: 'email', token: 'a@example.com', at: 1 });
    q.enqueue({ type: 'received', deliveryId: 'dlv_1', at: 2 });
    expect(await q.flush()).toBe(false);
    expect(seen).toEqual([]);
    expect(q.size).toBe(2);
  });

  it('SDK: addTag ardından addEmail → abonelik oluşur, tag aynı kullanıcıya yazılır', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addTag('a', '1');
    await tick();
    // Kullanıcı yok: tag kuyrukta bekler (atılmaz).
    expect(stored().queue.map((op) => op.type)).toEqual(['tags']);
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));
    const writes = api.calls.filter(
      (c) => (c.method === 'POST' && c.path === '/subscriptions') || c.method === 'PATCH',
    );
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /subscriptions',
      'PATCH /users/usr_1',
    ]);
    expect(api.find('PATCH', '/users/usr_1')[0]!.body).toEqual({ tags: { a: '1' } });
    hs.destroy();
  });
});

describe('olaylar: kimlik bekleme (B-16) ve sahiplik kanıtı (D-1)', () => {
  it('abonelik/external_id yokken olay atılmaz; login sonrası external_id + identity_hash ile gider', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.Session.sendEvent('early', undefined, 3);
    await tick(1200);
    expect(api.find('POST', '/events')).toHaveLength(0);
    expect(stored().queue.map((op) => op.type)).toEqual(['event']);

    const identityHash = 'd'.repeat(64);
    await hs.login('u-1', identityHash);
    await vi.waitFor(() => expect(api.find('POST', '/events')).toHaveLength(1), { timeout: 3000 });
    expect(eventsOf(api.find('POST', '/events'))).toEqual([
      expect.objectContaining({
        name: 'early',
        value: 3,
        external_id: 'u-1',
        identity_hash: identityHash,
      }),
    ]);
    expect(eventsOf(api.find('POST', '/events'))[0]).not.toHaveProperty('subscription_id');
    expect(hs.pendingOperations).toBe(0);
    hs.destroy();
  });

  it('push aboneliğinde token_hash, login varsa identity_hash eklenir; bilinmeyen app_version gönderilmez', async () => {
    const tokenHash = await digest('push-token');
    const identityHash = 'e'.repeat(64);
    localStorage.setItem(
      'hs:app_1',
      JSON.stringify({
        subscriptionId: 'sub_push',
        userId: 'usr_1',
        externalId: 'u-1',
        identityHash,
        optedIn: true,
        tokenHash,
      }),
    );
    // Boş sürüm etiketi "bilinmiyor" sayılır.
    document.head.innerHTML = '<meta name="hs-app-version" content="  ">';
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.Session.sendEvent('purchase', { sku: 'x' }, 9);
    await vi.waitFor(() => expect(api.find('POST', '/events')).toHaveLength(1), { timeout: 3000 });
    expect(eventsOf(api.find('POST', '/events'))[0]).toEqual({
      name: 'purchase',
      properties: { sku: 'x' },
      value: 9,
      occurred_at: expect.any(String) as unknown,
      subscription_id: 'sub_push',
      token_hash: tokenHash,
      identity_hash: identityHash,
    });
    const session = api.find('POST', '/sessions')[0]!.body!;
    expect(session).not.toHaveProperty('app_version');
    expect(session).toMatchObject({ subscription_id: 'sub_push', token_hash: tokenHash });
    hs.destroy();
  });
});

describe('§6.1 yüzey: izin gözlemcisi, clearAll, display, removeObserver', () => {
  const win = window as unknown as Record<string, unknown>;
  const original = {
    Notification: win.Notification,
    isSecureContext: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
    serviceWorker: Object.getOwnPropertyDescriptor(navigator, 'serviceWorker'),
    permissions: Object.getOwnPropertyDescriptor(navigator, 'permissions'),
  };
  let permission: NotificationPermission;
  let permissionStatus: EventTarget;
  let worker: EventTarget;
  let shown: { title: string; options: NotificationOptions }[];
  let displayed: { close: ReturnType<typeof vi.fn> }[];

  beforeEach(() => {
    permission = 'default';
    shown = [];
    displayed = [{ close: vi.fn() }, { close: vi.fn() }];
    const NotificationStub = {
      get permission() {
        return permission;
      },
      requestPermission: vi.fn(async () => {
        permission = 'denied';
        return permission;
      }),
    };
    vi.stubGlobal('Notification', NotificationStub);
    win.Notification = NotificationStub;
    win.PushManager = function PushManager() {};
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    const registration = {
      scope: '/',
      pushManager: { getSubscription: async () => null },
      showNotification: async (title: string, options: NotificationOptions) => {
        shown.push({ title, options });
      },
      getNotifications: async () => displayed,
    };
    worker = Object.assign(new EventTarget(), {
      register: async () => registration,
      ready: Promise.resolve(registration),
    });
    Object.defineProperty(navigator, 'serviceWorker', { value: worker, configurable: true });
    permissionStatus = new EventTarget();
    Object.defineProperty(navigator, 'permissions', {
      value: { query: async () => permissionStatus },
      configurable: true,
    });
  });

  afterEach(() => {
    win.Notification = original.Notification;
    delete win.PushManager;
    for (const [target, key, descriptor] of [
      [window, 'isSecureContext', original.isSecureContext],
      [navigator, 'serviceWorker', original.serviceWorker],
      [navigator, 'permissions', original.permissions],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete (target as unknown as Record<string, unknown>)[key];
    }
  });

  it('izin gözlemcisi istem sonucunu ve Permissions API değişimini bildirir; kaldırılınca susar', async () => {
    fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    const events: PermissionChangeEvent[] = [];
    const observer = (e: PermissionChangeEvent) => events.push(e);
    hs.Notifications.addPermissionObserver(observer);
    await tick();

    expect(await hs.Notifications.requestPermission()).toBe('denied');
    expect(events).toEqual([{ permission: false, state: 'denied' }]);

    // Kullanıcı site ayarlarından izni açtı.
    permission = 'granted';
    permissionStatus.dispatchEvent(new Event('change'));
    expect(events).toEqual([
      { permission: false, state: 'denied' },
      { permission: true, state: 'granted' },
    ]);
    // Değişiklik yoksa tekrar bildirilmez.
    permissionStatus.dispatchEvent(new Event('change'));
    expect(events).toHaveLength(2);

    hs.Notifications.removePermissionObserver(observer);
    permission = 'denied';
    permissionStatus.dispatchEvent(new Event('change'));
    expect(events).toHaveLength(2);
    hs.destroy();
  });

  it('pushSubscription.removeObserver gözlemciyi kaldırır', async () => {
    fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    const removed = vi.fn();
    const kept = vi.fn();
    hs.User.pushSubscription.addObserver(removed);
    hs.User.pushSubscription.addObserver(kept);
    hs.User.pushSubscription.removeObserver(removed);
    await hs.Notifications.requestPermission();
    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledWith(expect.objectContaining({ permission: 'denied' }));
    hs.destroy();
  });

  it('clearAll gösterilen bildirimleri kapatır', async () => {
    fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await hs.Notifications.clearAll();
    expect(displayed.every((n) => n.close.mock.calls.length === 1)).toBe(true);
    hs.destroy();
  });

  it('ön plan olayı: preventDefault sonrası display() aynı payload ile bir kez gösterir', async () => {
    fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    const replies: unknown[] = [];
    const pending: Promise<void>[] = [];
    hs.Notifications.addForegroundLifecycleListener((event) => {
      if (event.notification.title === 'Ertelenen') {
        event.preventDefault();
        pending.push(event.display(), event.display());
      } else {
        // Engellenmeyen bildirimi SW zaten gösterir: display() bir şey yapmaz.
        pending.push(event.display());
      }
    });
    const send = (title: string) => {
      const port = { postMessage: (data: unknown) => replies.push(data) };
      const message = new MessageEvent('message', {
        data: {
          type: 'hs:push-received',
          payload: { title, body: 'B', url: 'https://shop.test/x', hs: { dlv: 'dlv_1' } },
        },
      });
      Object.defineProperty(message, 'ports', { value: [port] });
      worker.dispatchEvent(message);
    };
    send('Ertelenen');
    send('Normal');
    await Promise.all(pending);
    expect(replies).toEqual([{ preventDefault: true }, { preventDefault: false }]);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Ertelenen');
    expect(shown[0]!.options.data).toMatchObject({
      url: 'https://shop.test/x',
      hs: { dlv: 'dlv_1' },
    });
    hs.destroy();
  });
});
