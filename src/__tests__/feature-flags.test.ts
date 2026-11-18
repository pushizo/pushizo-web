// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newFlagSubject, parseFeatureFlags } from '../core/feature-flags.js';
import { createSdk } from '../sdk.js';

/** Faz 39 (ADR-0066): Web SDK özellik bayrakları. */
describe('parseFeatureFlags', () => {
  it('geçerli satırları alır, bozuk satırı atlar', () => {
    expect(parseFeatureFlags({ flags: { a: { enabled: true, value: 1 }, b: { enabled: 'x' }, c: null } })).toEqual({ a: { enabled: true, value: 1 } });
  });

  it('bozuk yanıtta null döner', () => {
    expect(parseFeatureFlags(null)).toBeNull();
    expect(parseFeatureFlags({})).toBeNull();
    expect(parseFeatureFlags({ flags: 'x' })).toBeNull();
  });

  it('kimlikler tekil ve önekli', () => {
    const a = newFlagSubject();
    expect(a).toMatch(/^anon_[0-9a-f]{32}$/);
    expect(a).not.toBe(newFlagSubject());
  });
});

describe('Pushizo.FeatureFlags', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let bodies: Record<string, unknown>[] = [];
  let flagsResponse: () => Response;

  beforeEach(() => {
    localStorage.clear();
    bodies = [];
    flagsResponse = () => json(200, { flags: { yeni_sepet: { enabled: true, value: 'mavi' }, kapali: { enabled: false, value: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname.endsWith('/feature-flags/evaluate')) {
          bodies.push(JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>);
          return flagsResponse();
        }
        if (url.pathname.endsWith('/config')) return json(200, { app_id: 'app_1', name: 'A', api_url: url.origin, cell_id: null, identity_verification_required: false, identity_verification_mode: 'off', platforms: {}, web: { vapid_public_key: null, allowed_origins: [] }, session: { timeout_seconds: 30 } });
        return json(200, {});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const start = async () => {
    const sdk = createSdk();
    await sdk.init({ appId: 'app_1', apiUrl: 'https://api.example.com', webCampaigns: false });
    return sdk;
  };

  it('başlatınca değerleri alır, varsayılan yalnızca bilinmeyen anahtarda döner', async () => {
    const sdk = await start();
    await sdk.FeatureFlags.refresh();
    expect(sdk.FeatureFlags.isEnabled('yeni_sepet')).toBe(true);
    expect(sdk.FeatureFlags.isEnabled('kapali', true)).toBe(false);
    expect(sdk.FeatureFlags.isEnabled('bilinmeyen', true)).toBe(true);
    expect(sdk.FeatureFlags.getValue('yeni_sepet', 'kirmizi')).toBe('mavi');
    expect(sdk.FeatureFlags.getValue('bilinmeyen', 'kirmizi')).toBe('kirmizi');
  });

  it('abonelik yokken aynı rastgele kimliği gönderir', async () => {
    const sdk = await start();
    await sdk.FeatureFlags.refresh();
    await sdk.FeatureFlags.refresh();
    const subjects = bodies.map((b) => b.subject);
    expect(subjects[0]).toMatch(/^anon_/);
    expect(new Set(subjects).size).toBe(1);
  });

  it('sunucu hatasında son değerler korunur', async () => {
    const sdk = await start();
    await sdk.FeatureFlags.refresh();
    // 4xx yeniden denenmez: hata anında sonuçlanır.
    flagsResponse = () => json(400, { error: 'x' });
    await sdk.FeatureFlags.refresh();
    expect(sdk.FeatureFlags.getValue('yeni_sepet', 'kirmizi')).toBe('mavi');
  });

  it('gözlemci değişimde çağrılır, kaldırılınca çağrılmaz', async () => {
    const sdk = await start();
    await sdk.FeatureFlags.refresh();
    const listener = vi.fn();
    const remove = sdk.FeatureFlags.addObserver(listener);
    await sdk.FeatureFlags.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    remove();
    await sdk.FeatureFlags.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('gizlilik onayı beklenirken istek gönderilmez', async () => {
    const sdk = createSdk();
    await sdk.init({ appId: 'app_1', apiUrl: 'https://api.example.com', webCampaigns: false, requiresPrivacyConsent: true });
    await sdk.FeatureFlags.refresh();
    expect(bodies).toEqual([]);
    expect(sdk.FeatureFlags.isEnabled('yeni_sepet', false)).toBe(false);
  });
});
