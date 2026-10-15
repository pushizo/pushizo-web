// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedState } from '../core/types.js';
import { createSdk } from '../sdk.js';

/** JWT identity verification (ADR-0023 §9): belirteç `Authorization: Bearer` ile gider; mod kuralları; yenileme. */
interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeApi(mode: 'hmac' | 'jwt' | 'both', required = true) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace('/sdk/v1/apps/app_1', '');
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method ?? 'GET', path, auth: headers.get('authorization'), body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined });
      const route = `${init?.method ?? 'GET'} ${path}`;
      if (route === 'GET /config')
        return json(200, {
          app_id: 'app_1',
          name: 'Test',
          identity_verification_required: required,
          identity_verification_mode: mode,
          platforms: { web: true, email: true, sms: true },
          web: { vapid_public_key: null, allowed_origins: [] },
          session: { timeout_seconds: 30 },
        });
      if (route === 'POST /subscriptions/sub_push/login') return json(200, { user_id: 'usr_1', external_id: 'u-1', tags: {} });
      if (route === 'POST /subscriptions/sub_push/logout') return json(200, { user_id: 'usr_2', external_id: null, tags: {} });
      if (route === 'GET /in-app') return json(200, { language: 'en', data: [] });
      if (route === 'POST /events' || route === 'POST /sessions') return json(200, { accepted: 1 });
      if (route.startsWith('PATCH /users/')) return json(200, { user_id: 'usr_1', tags: {} });
      return json(404, { error: { code: 'HS_NOT_FOUND', message: route } });
    }),
  );
  return { calls, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

const stored = () => JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as PersistedState;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('hs:app_1', JSON.stringify({ subscriptionId: 'sub_push', userId: 'usr_0', optedIn: true, tokenHash: 'a'.repeat(64) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Web SDK JWT kimlik doğrulaması', () => {
  it('login(id, { jwt }) belirteci başlıkta taşır (gövdede değil); sonraki istekler de taşır; logout siler', async () => {
    const api = fakeApi('jwt');
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await hs.login('u-1', { jwt: 'h.p.s' });
    const login = api.find('POST', '/subscriptions/sub_push/login')[0]!;
    expect(login.auth).toBe('Bearer h.p.s');
    expect(JSON.stringify(login.body)).not.toContain('h.p.s');
    expect(stored().identityJwt).toBe('h.p.s');

    await hs.updateUserJwt('h.p.s2');
    hs.User.addTag('plan', 'pro');
    await vi.waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true), { timeout: 3000 });
    expect(api.calls.find((c) => c.method === 'PATCH')!.auth).toBe('Bearer h.p.s2');

    await hs.logout();
    expect(stored().identityJwt).toBeNull();
    hs.destroy();
  });

  it('jwt modunda JWT olmadan, hmac modunda hash olmadan login reddedilir; both modunda biri yeter', async () => {
    fakeApi('jwt');
    const a = createSdk();
    await a.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await expect(a.login('u-1', 'f'.repeat(64))).rejects.toThrow(/JWT/);
    a.destroy();
    vi.unstubAllGlobals();

    fakeApi('hmac');
    const b = createSdk();
    await b.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await expect(b.login('u-1', { jwt: 'h.p.s' })).rejects.toThrow(/identityHash/);
    b.destroy();
    vi.unstubAllGlobals();

    const api = fakeApi('both');
    const c = createSdk();
    await c.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await c.login('u-1', { identityHash: 'f'.repeat(64) });
    expect(api.find('POST', '/subscriptions/sub_push/login')[0]!.body).toMatchObject({ identity_hash: 'f'.repeat(64) });
    c.destroy();
  });

  it('updateUserJwt giriş yapılmadan kullanılamaz', async () => {
    fakeApi('jwt', false);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await expect(hs.updateUserJwt('x.y.z')).rejects.toThrow(/login/);
    hs.destroy();
  });
});
