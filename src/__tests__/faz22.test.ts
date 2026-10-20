// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../core/token.js';
import { createSdk } from '../sdk.js';

/** v3 Faz 22 / ADR-0037: reklam kişiselleştirme rızası (`User.setAdsPersonalizationConsent`, `getConsents`). */

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeApi() {
  const calls: Call[] = [];
  let granted = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace('/sdk/v1/apps/app_1', '');
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      calls.push({ method: init?.method ?? 'GET', path, query: Object.fromEntries(url.searchParams), body });
      const route = `${init?.method ?? 'GET'} ${path}`;
      if (route === 'GET /config')
        return json(200, {
          app_id: 'app_1',
          name: 'Test',
          identity_verification_required: false,
          platforms: { ios: false, android: false, web: true, email: true, sms: true },
          web: { vapid_public_key: null, allowed_origins: [], prompt: null },
          session: { timeout_seconds: 30 },
          in_app: { min_interval_seconds: 0 },
          android_channels: [],
          categories: [],
        });
      if (route === 'POST /subscriptions') return json(200, { subscription_id: 'sub_mail', user_id: 'usr_1', external_id: null, status: 'subscribed', created: true });
      if (route === 'PUT /preferences') {
        const pref = (body?.preferences as { category: string; opted_in: boolean }[] | undefined)?.find((p) => p.category === 'ads_personalization');
        if (pref) granted = pref.opted_in;
      }
      if (route === 'GET /preferences' || route === 'PUT /preferences')
        return json(200, {
          data: [],
          categories: [],
          consents: [{ purpose: 'ads_personalization', granted, source: granted ? 'sdk' : null, updated_at: granted ? '2026-10-20T10:00:00.000Z' : null }],
        });
      if (route === 'GET /in-app') return json(200, { language: 'tr', data: [] });
      if (route === 'POST /events' || route === 'POST /sessions') return json(200, { accepted: 1 });
      return json(404, { error: { code: 'HS_NOT_FOUND', message: route } });
    }),
  );
  return { calls, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('reklam kişiselleştirme rızası', () => {
  it('rıza tercih ucuyla (ayrılmış anahtar) yazılır, okunur ve geri alınır; abonelik yoksa hata', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await expect(hs.User.getConsents()).rejects.toThrow(/abonelik gerekli/);
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));

    hs.User.setAdsPersonalizationConsent(true);
    await vi.waitFor(() => expect(api.find('PUT', '/preferences')).toHaveLength(1));
    const hash = await digest('a@example.com');
    expect(api.find('PUT', '/preferences')[0]!.body).toEqual({ subscription_id: 'sub_mail', token_hash: hash, preferences: [{ category: 'ads_personalization', opted_in: true }] });
    expect(await hs.User.getConsents()).toEqual([{ purpose: 'ads_personalization', granted: true, source: 'sdk', updatedAt: '2026-10-20T10:00:00.000Z' }]);
    expect((await hs.User.getPreferences()).consents[0]!.granted).toBe(true);

    hs.User.setAdsPersonalizationConsent(false);
    await vi.waitFor(() => expect(api.find('PUT', '/preferences')).toHaveLength(2));
    expect(api.find('PUT', '/preferences')[1]!.body!.preferences).toEqual([{ category: 'ads_personalization', opted_in: false }]);
    expect((await hs.User.getConsents())[0]!.granted).toBe(false);
    hs.destroy();
  });
});
