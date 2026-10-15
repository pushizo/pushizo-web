// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkApi } from '../core/api.js';
import { acceptApiUrl, rebaseSdkUrl, sdkUrlBase, wrongCellTarget } from '../core/cell.js';
import { Logger } from '../core/logger.js';
import type { PersistedState } from '../core/types.js';
import { createSdk } from '../sdk.js';

/** Hücre yönlendirmesi (ADR-0032 §4): config `api_url` ve 421 `HS_WRONG_CELL`. */
interface Vectors {
  accept: { name: string; candidate: unknown; current: string; expected: string | null }[];
  wrong_cell: { name: string; status: number; body: unknown; current: string; expected: string | null }[];
}

// Paket tsconfig'i Node tiplerini içermez; Vitest (Node) çalışma zamanında modülleri ve __dirname'i sağlar.
declare const __dirname: string;
const fs = await vi.importActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('node:fs');
const path = await vi.importActual<{ resolve(...parts: string[]): string }>('node:path');
const vectors = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../testdata/cell-routing-vectors.json'), 'utf8'),
) as Vectors;

const logger = new Logger('silent');
const href = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrongCell = (apiUrl: string) =>
  json(421, { error: { code: 'HS_WRONG_CELL', message: 'x', details: { cell_id: 'eu', api_url: apiUrl } } });

describe('ortak vektörler (sdk/testdata/cell-routing-vectors.json)', () => {
  it.each(vectors.accept.map((v) => [v.name, v] as const))('acceptApiUrl: %s', (_name, v) => {
    expect(acceptApiUrl(v.candidate, v.current)).toBe(v.expected);
  });
  it.each(vectors.wrong_cell.map((v) => [v.name, v] as const))('wrongCellTarget: %s', (_name, v) => {
    expect(wrongCellTarget(v.status, v.body, v.current)).toBe(v.expected);
  });
});

describe('SDK istek adresi yardımcıları', () => {
  it('kök ayrıştırılır ve değiştirilir', () => {
    const url = 'https://api.test/sdk/v1/apps/app_1/deliveries/d1/opened';
    expect(sdkUrlBase(url)).toBe('https://api.test');
    expect(rebaseSdkUrl(url, 'https://api.eu.test')).toBe('https://api.eu.test/sdk/v1/apps/app_1/deliveries/d1/opened');
    expect(sdkUrlBase('https://api.test/other')).toBeNull();
    expect(rebaseSdkUrl('https://api.test/other', 'https://x')).toBeNull();
  });
});

describe('SdkApi 421 HS_WRONG_CELL', () => {
  it('details.api_url köküne geçer, isteği bir kez yeniden dener ve değişikliği bildirir', async () => {
    const calls: string[] = [];
    const changes: string[] = [];
    const api = new SdkApi({
      baseUrl: 'https://api.test',
      appId: 'app_1',
      logger,
      sleep: async () => undefined,
      onBaseUrlChange: (url) => changes.push(url),
      fetch: async (input: RequestInfo | URL) => {
        calls.push(href(input));
        return href(input).startsWith('https://api.test/') ? wrongCell('https://api.eu.test/') : json(200, { ok: true });
      },
    });
    expect(await api.request('POST', '/events', { x: 1 })).toEqual({ ok: true });
    expect(calls).toEqual(['https://api.test/sdk/v1/apps/app_1/events', 'https://api.eu.test/sdk/v1/apps/app_1/events']);
    expect(changes).toEqual(['https://api.eu.test']);
    expect(api.baseUrl).toBe('https://api.eu.test');
    // Sonraki istekler doğrudan yeni köke gider (kuyruktaki işlemler dahil).
    await api.request('GET', '/config');
    expect(calls.at(-1)).toBe('https://api.eu.test/sdk/v1/apps/app_1/config');
  });

  it('hücreler birbirini gösterse de istek başına tek yönlendirme izlenir (döngü yok)', async () => {
    const calls: string[] = [];
    const api = new SdkApi({
      baseUrl: 'https://a.test',
      appId: 'app_1',
      logger,
      sleep: async () => undefined,
      fetch: async (input: RequestInfo | URL) => {
        calls.push(href(input));
        return wrongCell(href(input).startsWith('https://a.test') ? 'https://b.test' : 'https://a.test');
      },
    });
    await expect(api.request('GET', '/config')).rejects.toMatchObject({ status: 421, code: 'HS_WRONG_CELL', retryable: false });
    expect(calls).toHaveLength(2);
  });

  it('geçersiz (https olmayan) api_url izlenmez; hata yeniden denenmez', async () => {
    const calls: string[] = [];
    const api = new SdkApi({
      baseUrl: 'https://api.test',
      appId: 'app_1',
      logger,
      sleep: async () => undefined,
      fetch: async (input: RequestInfo | URL) => {
        calls.push(href(input));
        return wrongCell('http://evil.test');
      },
    });
    await expect(api.request('GET', '/config')).rejects.toMatchObject({ status: 421, code: 'HS_WRONG_CELL' });
    expect(calls).toHaveLength(1);
    expect(api.baseUrl).toBe('https://api.test');
  });
});

describe('Web SDK bölgesel API kökü', () => {
  const config = (apiUrl: string | null) => ({
    app_id: 'app_1',
    name: 'Test',
    identity_verification_required: false,
    platforms: { web: true, email: true, sms: true },
    web: { vapid_public_key: null, allowed_origins: [] },
    session: { timeout_seconds: 30 },
    api_url: apiUrl,
    cell_id: 'eu',
  });

  function fakeApi(handler: (url: URL, method: string) => Response | undefined) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url.origin}${url.pathname}`);
        const res = handler(url, method);
        if (res) return res;
        if (url.pathname.endsWith('/in-app')) return json(200, { language: 'en', data: [] });
        return json(200, { accepted: 1 });
      }),
    );
    return calls;
  }

  const stored = () => JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as PersistedState;

  beforeEach(() => {
    localStorage.clear();
    // Olayların gönderilmesi için kayıtlı abonelik.
    localStorage.setItem('hs:app_1', JSON.stringify({ subscriptionId: 'sub_1', userId: 'usr_1', optedIn: true }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('apiUrl verilmediyse config api_url benimsenir ve saklanır; sonraki init doğrudan bölgesel köke gider', async () => {
    const calls = fakeApi((url) => (url.pathname.endsWith('/config') ? json(200, config('https://api.eu.test')) : undefined));
    const hs = createSdk();
    await hs.init({ appId: 'app_1', logLevel: 'silent' });
    const seed = window.location.origin;
    expect(calls[0]).toBe(`GET ${seed}/sdk/v1/apps/app_1/config`);
    expect(stored()).toMatchObject({ regionalApiUrl: 'https://api.eu.test', regionalApiSeed: seed });
    hs.Session.sendEvent('evt');
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith('POST https://api.eu.test/'))).toBe(true), { timeout: 3000 });
    hs.destroy();

    calls.length = 0;
    const again = createSdk();
    await again.init({ appId: 'app_1', logLevel: 'silent' });
    expect(calls[0]).toBe('GET https://api.eu.test/sdk/v1/apps/app_1/config');
    again.destroy();
  });

  it('global varsayılan kök (Flutter web/köprüler) açık seçim sayılmaz; config api_url benimsenir', async () => {
    const calls = fakeApi((url) => (url.pathname.endsWith('/config') ? json(200, config('https://api.eu.test')) : undefined));
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.herosignal.dev/', logLevel: 'silent' });
    expect(calls[0]).toBe('GET https://api.herosignal.dev/sdk/v1/apps/app_1/config');
    expect(stored()).toMatchObject({ regionalApiUrl: 'https://api.eu.test', regionalApiSeed: 'https://api.herosignal.dev' });
    hs.destroy();
  });

  it('açık apiUrl config api_url ile değiştirilmez', async () => {
    const calls = fakeApi((url) => (url.pathname.endsWith('/config') ? json(200, config('https://api.eu.test')) : undefined));
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://proxy.example.com', logLevel: 'silent' });
    hs.Session.sendEvent('evt');
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith('POST '))).toBe(true), { timeout: 3000 });
    expect(calls.every((c) => c.includes('https://proxy.example.com/'))).toBe(true);
    expect(stored().regionalApiUrl).toBeNull();
    hs.destroy();
  });

  it('açık apiUrl ile 421 HS_WRONG_CELL izlenir, saklanır; apiUrl değişirse kayıt kullanılmaz', async () => {
    const calls = fakeApi((url) => {
      if (url.origin === 'https://api.test') return wrongCell('https://api.tr.test');
      return url.pathname.endsWith('/config') ? json(200, config('https://api.tr.test')) : undefined;
    });
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    expect(calls.slice(0, 2)).toEqual([
      'GET https://api.test/sdk/v1/apps/app_1/config',
      'GET https://api.tr.test/sdk/v1/apps/app_1/config',
    ]);
    expect(stored()).toMatchObject({ regionalApiUrl: 'https://api.tr.test', regionalApiSeed: 'https://api.test' });
    hs.destroy();

    calls.length = 0;
    const other = createSdk();
    await other.init({ appId: 'app_1', apiUrl: 'https://other.test', logLevel: 'silent' });
    expect(calls[0]).toBe('GET https://other.test/sdk/v1/apps/app_1/config');
    other.destroy();
  });

  it('config api_url https değilse yok sayılır', async () => {
    const calls = fakeApi((url) => (url.pathname.endsWith('/config') ? json(200, config('http://evil.test')) : undefined));
    const hs = createSdk();
    await hs.init({ appId: 'app_1', logLevel: 'silent' });
    hs.Session.sendEvent('evt');
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith('POST '))).toBe(true), { timeout: 3000 });
    expect(calls.some((c) => c.includes('evil.test'))).toBe(false);
    expect(stored().regionalApiUrl).toBeNull();
    hs.destroy();
  });
});
