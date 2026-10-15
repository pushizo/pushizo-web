// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATION_MAX_ACCURACY_M, LOCATION_MIN_INTERVAL_MS, locationFromCoords, locationRefreshDue } from '../core/location.js';
import { OfflineQueue } from '../core/queue.js';
import { MemoryStore, StateStore } from '../core/storage.js';
import { Logger } from '../core/logger.js';
import type { PersistedState } from '../core/types.js';
import { createSdk } from '../sdk.js';

/** v2 Faz 17b — Web SDK konum paylaşımı: kurallar, kuyruk birleştirme ve `Location` API'si. */

const TOKEN_HASH = 'a'.repeat(64);

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeApi() {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace('/sdk/v1/apps/app_1', '');
      const call: Call = {
        method: init?.method ?? 'GET',
        path,
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      if (path === '/config')
        return json(200, {
          app_id: 'app_1',
          identity_verification_required: false,
          web: { vapid_public_key: null, allowed_origins: [], prompt: null },
          session: { timeout_seconds: 30 },
          in_app: { min_interval_seconds: 0 },
          categories: [],
        });
      if (path === '/in-app') return json(200, { language: 'tr', data: [] });
      if (call.method === 'PATCH' && path.startsWith('/subscriptions/')) return json(200, { subscription_id: 'sub_push' });
      if (path === '/sessions' || path === '/events' || path === '/errors') return json(200, { accepted: 1 });
      return json(404, { error: { code: 'HS_NOT_FOUND', message: path } });
    }),
  );
  return { calls, patches: () => calls.filter((c) => c.method === 'PATCH' && c.path === '/subscriptions/sub_push') };
}

type PermissionStateName = 'granted' | 'denied' | 'prompt';

/** `navigator.geolocation` + `navigator.permissions` sahtesi; `permission` testte değiştirilebilir. */
function fakeGeolocation(initial: PermissionStateName, coords = { latitude: 41.0082, longitude: 28.9784, accuracy: 35 }) {
  const state = { permission: initial, prompts: 0, reads: 0, grantOnPrompt: true, coords };
  const geolocation = {
    getCurrentPosition: vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => {
      state.reads += 1;
      if (state.permission === 'prompt') {
        state.prompts += 1;
        state.permission = state.grantOnPrompt ? 'granted' : 'denied';
      }
      if (state.permission === 'denied') {
        fail({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
        return;
      }
      ok({ coords: state.coords, timestamp: Date.now() } as unknown as GeolocationPosition);
    }),
  };
  const permissions = { query: vi.fn(async () => ({ state: state.permission })) };
  Object.defineProperty(navigator, 'geolocation', { value: geolocation, configurable: true });
  Object.defineProperty(navigator, 'permissions', { value: permissions, configurable: true });
  return state;
}

/** Kayıtlı push aboneliği olan cihaz durumu (Web Push happy-dom'da olmadığından depodan başlatılır). */
function seedSubscription(patch: Partial<PersistedState> = {}) {
  localStorage.setItem(
    'hs:app_1',
    JSON.stringify({ subscriptionId: 'sub_push', userId: 'usr_1', tokenHash: TOKEN_HASH, optedIn: true, ...patch }),
  );
}

const stored = () => JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as PersistedState;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('konum kuralları (core/location)', () => {
  it('koordinatları doğrular, 6 ondalığa yuvarlar ve doğruluğu sınırlar', () => {
    expect(locationFromCoords({ latitude: 41.00823456, longitude: 28.97841234, accuracy: 12.34 })).toEqual({
      lat: 41.008235,
      lng: 28.978412,
      accuracy_m: 12.3,
    });
    expect(locationFromCoords({ latitude: 10, longitude: 20, accuracy: 5_000_000 })?.accuracy_m).toBe(LOCATION_MAX_ACCURACY_M);
    expect(locationFromCoords({ latitude: 10, longitude: 20, accuracy: null })).toEqual({ lat: 10, lng: 20 });
    expect(locationFromCoords({ latitude: 91, longitude: 0 })).toBeNull();
    expect(locationFromCoords({ latitude: 0, longitude: -180.5 })).toBeNull();
    expect(locationFromCoords({ latitude: Number.NaN, longitude: 0 })).toBeNull();
  });

  it('5 dakika aralığı: paylaşım kapalıyken hiç, ilk kez ve süre dolunca gönderilir', () => {
    const now = 1_000_000_000;
    expect(locationRefreshDue(false, null, now)).toBe(false);
    expect(locationRefreshDue(true, null, now)).toBe(true);
    expect(locationRefreshDue(true, now - LOCATION_MIN_INTERVAL_MS + 1, now)).toBe(false);
    expect(locationRefreshDue(true, now - LOCATION_MIN_INTERVAL_MS, now)).toBe(true);
    expect(locationRefreshDue(true, now - 1000, now, true)).toBe(true);
    // Saat geri alındıysa beklenmez.
    expect(locationRefreshDue(true, now + 60_000, now)).toBe(true);
  });

  it('kuyrukta yalnızca son konum işlemi tutulur; abonelik yokken konum bekler, null atılır', async () => {
    const store = new StateStore('app_q', new MemoryStore());
    const handled: string[] = [];
    const queue = new OfflineQueue(store, async (op) => {
      handled.push(op.type);
    }, new Logger());
    queue.enqueue({ type: 'location', location: { lat: 1, lng: 2 }, at: 1 });
    queue.enqueue({ type: 'tags', tags: { a: '1' }, at: 2 });
    queue.enqueue({ type: 'location', location: null, at: 3 });
    expect(store.get().queue.map((op) => op.type)).toEqual(['tags', 'location']);
    expect(store.get().queue[1]).toMatchObject({ location: null });
    await queue.flush();
    expect(handled).toEqual(['tags', 'location']);
  });
});

describe('Location API', () => {
  it('izin varken setShared(true) konumu sahiplik kanıtıyla PATCH eder; 5 dk içinde tekrar göndermez', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 15, 9));
    seedSubscription();
    const api = fakeApi();
    const geo = fakeGeolocation('granted');
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    expect(hs.Location.isShared).toBe(false);
    await tick();
    expect(geo.reads).toBe(0);

    hs.Location.setShared(true);
    expect(hs.Location.isShared).toBe(true);
    await vi.waitFor(() => expect(api.patches()).toHaveLength(1));
    expect(api.patches()[0]!.body).toEqual({
      location: { lat: 41.0082, lng: 28.9784, accuracy_m: 35 },
      token_hash: TOKEN_HASH,
    });
    expect(stored().locationShared).toBe(true);
    expect(geo.prompts).toBe(0);

    // Ön plana dönüş: aralık dolmadan konum okunmaz.
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(geo.reads).toBe(1);
    vi.setSystemTime(Date.now() + LOCATION_MIN_INTERVAL_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(api.patches()).toHaveLength(2));
    hs.destroy();
  });

  it('setShared(false) location: null gönderir; paylaşım kalıcıdır ve oturum başında konum yenilenir', async () => {
    seedSubscription({ locationShared: true, locationSentAt: null });
    const api = fakeApi();
    fakeGeolocation('granted');
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    // Kalıcı tercih: init sonrası oturum başında konum gönderilir.
    await vi.waitFor(() => expect(api.patches()).toHaveLength(1));
    expect(hs.Location.isShared).toBe(true);

    hs.Location.setShared(false);
    await vi.waitFor(() => expect(api.patches()).toHaveLength(2));
    expect(api.patches()[1]!.body).toEqual({ location: null, token_hash: TOKEN_HASH });
    expect(stored().locationShared).toBe(false);
    expect(stored().locationSentAt).toBeNull();
    // Zaten kapalıyken tekrar kapatmak istek göndermez.
    hs.Location.setShared(false);
    await tick();
    expect(api.patches()).toHaveLength(2);
    hs.destroy();
  });

  it('izin yokken sessizce göndermez ve istem açmaz', async () => {
    seedSubscription();
    const api = fakeApi();
    const geo = fakeGeolocation('prompt');
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.Location.setShared(true);
    await tick();
    expect(geo.reads).toBe(0);
    expect(api.patches()).toHaveLength(0);
    hs.destroy();
  });

  it('requestPermission: açıklama kutusu, ret ve kabul; kabulde paylaşım açıksa konum gönderilir', async () => {
    seedSubscription();
    const api = fakeApi();
    const geo = fakeGeolocation('prompt');
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent', language: 'tr' });
    hs.Location.setShared(true);

    // Açıklama reddedilirse tarayıcı istemi açılmaz.
    const declined = hs.Location.requestPermission('Yakındaki mağazaları göstermek için');
    await vi.waitFor(() => expect(document.querySelector('.hs-slidedown')).not.toBeNull());
    expect(document.querySelector('.hs-slidedown p')?.textContent).toBe('Yakındaki mağazaları göstermek için');
    expect(document.querySelector('.hs-slidedown .hs-accept')?.textContent).toBe('Devam');
    document.querySelector<HTMLButtonElement>('.hs-slidedown .hs-cancel')!.click();
    expect(await declined).toBe(false);
    expect(geo.prompts).toBe(0);

    const accepted = hs.Location.requestPermission('Yakındaki mağazaları göstermek için');
    await vi.waitFor(() => expect(document.querySelector('.hs-slidedown')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.hs-slidedown .hs-accept')!.click();
    expect(await accepted).toBe(true);
    expect(geo.prompts).toBe(1);
    expect(stored().locationPermissionGranted).toBe(true);
    await vi.waitFor(() => expect(api.patches()).toHaveLength(1));

    // İzin zaten varsa açıklama gösterilmez.
    expect(await hs.Location.requestPermission('tekrar')).toBe(true);
    expect(document.querySelector('.hs-slidedown')).toBeNull();
    hs.destroy();
  });

  it('requestPermission: açıklama verilmezse varsayılan metin; reddedilen izin false döner; geolocation yoksa false', async () => {
    seedSubscription();
    fakeApi();
    const geo = fakeGeolocation('prompt');
    geo.grantOnPrompt = false;
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent', language: 'en' });
    const pending = hs.Location.requestPermission();
    await vi.waitFor(() => expect(document.querySelector('.hs-slidedown')).not.toBeNull());
    expect(document.querySelector('.hs-slidedown h3')?.textContent).toBe('Share your location');
    expect(document.querySelector('.hs-slidedown p')?.textContent).toMatch(/approximate location only while the site is open/);
    document.querySelector<HTMLButtonElement>('.hs-slidedown .hs-accept')!.click();
    expect(await pending).toBe(false);
    // Reddedilmiş izin yeniden sorulmaz (açıklama da gösterilmez).
    expect(await hs.Location.requestPermission()).toBe(false);
    expect(document.querySelector('.hs-slidedown')).toBeNull();
    expect(geo.prompts).toBe(1);
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    expect(await hs.Location.requestPermission()).toBe(false);
    hs.destroy();
  });

  it('gizlilik onayı yokken konum hiç okunmaz ve gönderilmez; onay geri çekilince paylaşım kapanır', async () => {
    seedSubscription();
    const api = fakeApi();
    const geo = fakeGeolocation('granted');
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent', requiresPrivacyConsent: true });
    hs.Location.setShared(true);
    await tick();
    expect(geo.reads).toBe(0);
    expect(api.calls).toHaveLength(0);

    await hs.setConsentGiven(true);
    await vi.waitFor(() => expect(api.patches()).toHaveLength(1));

    await hs.setConsentGiven(false);
    expect(hs.Location.isShared).toBe(false);
    hs.destroy();
  });

  it('push aboneliği yokken konum kuyrukta bekler', async () => {
    const api = fakeApi();
    fakeGeolocation('granted');
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.Location.setShared(true);
    await vi.waitFor(() => expect(stored().queue.some((op) => op.type === 'location')).toBe(true));
    await tick();
    expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    hs.destroy();
  });

  it('init öncesi çağrı açıklayıcı hata verir', async () => {
    const hs = createSdk();
    expect(() => hs.Location.setShared(true)).toThrow(/init/);
    await expect(hs.Location.requestPermission()).rejects.toThrow(/init/);
    expect(hs.Location.isShared).toBe(false);
  });
});
