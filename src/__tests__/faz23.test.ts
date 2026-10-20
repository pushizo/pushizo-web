// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureTouch,
  isRepeatTouch,
  landingUrl,
  pruneAttribution,
  referrerHost,
  resolveAttributionOptions,
  touchParams,
} from '../core/attribution.js';
import type { AttributionTouch, PersistedState } from '../core/types.js';
import { createSdk } from '../sdk.js';

/** v3 Faz 23: birleşik atribüsyon (UTM + reklam tıklama kimliği yakalama). */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const defaults = resolveAttributionOptions(undefined);

const capture = (search: string, extra: Partial<Parameters<typeof captureTouch>[0]> = {}) =>
  captureTouch({
    search,
    href: `https://shop.example.com/kampanya${search}#bolum`,
    referrer: '',
    ownHost: 'shop.example.com',
    now: NOW,
    touchId: 'touch_0001',
    state: null,
    options: defaults,
    ...extra,
  });

describe('atribüsyon saf mantığı', () => {
  it('UTM alanlarını kırpar/sınırlar, boşları atar; tıklama kimliğinde öncelik sırası uygulanır', () => {
    const params = touchParams(
      `?utm_source=%20facebook%20&utm_medium=cpc&utm_campaign=${'c'.repeat(250)}&utm_term=&utm_id=42&msclkid=ms1&gclid=g1&fbclid=fb1`,
      true,
    );
    expect(params).toEqual({
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'c'.repeat(200),
      utm_id: '42',
      click_id_type: 'fbclid',
      click_id: 'fb1',
    });
    expect(touchParams('?gbraid=b1&ttclid=t1', true)).toEqual({ click_id_type: 'gbraid', click_id: 'b1' });
    expect(touchParams(`?li_fat_id=${'x'.repeat(600)}`, true)?.click_id).toHaveLength(500);
    expect(touchParams('?q=ara&ref=x', true)).toBeNull();
  });

  it('captureClickIds=false iken yalnızca tıklama kimliği olan adres dokunuş üretmez', () => {
    expect(touchParams('?gclid=g1', false)).toBeNull();
    expect(touchParams('?gclid=g1&utm_source=google', false)).toEqual({ utm_source: 'google' });
  });

  it('landing_url yalnızca origin + yol; referrer yalnızca dış host', () => {
    expect(landingUrl('https://shop.example.com/a/b?email=a@b.com&utm_source=x#token')).toBe('https://shop.example.com/a/b');
    expect(landingUrl('bozuk')).toBeUndefined();
    expect(referrerHost('https://www.google.com/search?q=gizli', 'shop.example.com')).toBe('www.google.com');
    expect(referrerHost('https://shop.example.com/onceki', 'shop.example.com')).toBeUndefined();
    expect(referrerHost('', 'shop.example.com')).toBeUndefined();
  });

  it('windowDays 1–90 aralığına kırpılır; varsayılan 30 gün', () => {
    expect(defaults).toEqual({ enabled: true, windowMs: 30 * DAY, captureClickIds: true });
    expect(resolveAttributionOptions({ windowDays: 365 }).windowMs).toBe(90 * DAY);
    expect(resolveAttributionOptions({ windowDays: 0 }).windowMs).toBe(DAY);
    expect(resolveAttributionOptions({ windowDays: Number.NaN }).windowMs).toBe(30 * DAY);
  });

  it('pencere dışına düşen ve tarihi bozuk kayıtlar atılır', () => {
    const touch = (daysAgo: number): AttributionTouch => ({
      touch_id: `touch_${daysAgo}xxxx`,
      occurred_at: new Date(NOW - daysAgo * DAY).toISOString(),
      utm_source: 'x',
    });
    const state = { first: touch(31), last: touch(29) };
    expect(pruneAttribution(state, NOW, 30 * DAY)).toEqual({ first: null, last: state.last });
    expect(pruneAttribution({ first: { ...touch(1), occurred_at: 'bozuk' }, last: null }, NOW, 30 * DAY).first).toBeNull();
  });

  it('ilk dokunuş korunur, son dokunuş güncellenir; aynı parametrelerle 30 dk içinde tekrar üretilmez', () => {
    const first = capture('?utm_source=facebook&utm_campaign=c1')!;
    expect(first.touch).toEqual({
      touch_id: 'touch_0001',
      occurred_at: '2026-10-20T10:00:00.000Z',
      utm_source: 'facebook',
      utm_campaign: 'c1',
      landing_url: 'https://shop.example.com/kampanya',
    });
    expect(first.state).toEqual({ first: first.touch, last: first.touch });
    // Yenileme: aynı parametre kümesi, 10 dk sonra.
    expect(capture('?utm_source=facebook&utm_campaign=c1', { state: first.state, now: NOW + 10 * 60_000 })).toBeNull();
    expect(isRepeatTouch(first.touch, { utm_source: 'facebook', utm_campaign: 'c1' }, NOW + 31 * 60_000)).toBe(false);
    const second = capture('?utm_source=google&gclid=g1', {
      state: first.state,
      now: NOW + DAY,
      touchId: 'touch_0002',
      referrer: 'https://www.google.com/',
    })!;
    expect(second.state.first).toBe(first.touch);
    expect(second.state.last).toMatchObject({ touch_id: 'touch_0002', utm_source: 'google', click_id_type: 'gclid', click_id: 'g1', referrer: 'www.google.com' });
    // İlk dokunuş penceredan çıktıysa yeni dokunuş ilk dokunuş olur.
    const later = capture('?utm_source=tiktok', { state: first.state, now: NOW + 31 * DAY, touchId: 'touch_0003' })!;
    expect(later.state.first?.touch_id).toBe('touch_0003');
    expect(capture('?utm_source=x', { options: { ...defaults, enabled: false } })).toBeNull();
  });
});

// --- SDK entegrasyonu ---

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeApi(options: { attributionStatus?: number[] } = {}) {
  const calls: Call[] = [];
  const statuses = [...(options.attributionStatus ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace('/sdk/v1/apps/app_1', '');
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      calls.push({ method: init?.method ?? 'GET', path, body });
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
      if (route === 'POST /attribution') {
        const status = statuses.shift() ?? 200;
        return status === 200 ? json(200, { accepted: 1 }) : json(status, { error: { code: 'HS_UNAVAILABLE', message: 'x' } });
      }
      if (route === 'POST /subscriptions') return json(200, { subscription_id: 'sub_mail', user_id: 'usr_1', external_id: null, status: 'subscribed', created: true });
      if (route === 'GET /in-app') return json(200, { language: 'tr', data: [] });
      if (route === 'POST /events' || route === 'POST /sessions') return json(200, { accepted: 1 });
      return json(404, { error: { code: 'HS_NOT_FOUND', message: route } });
    }),
  );
  return { calls, attribution: () => calls.filter((c) => c.method === 'POST' && c.path === '/attribution') };
}

const saved = (): Partial<PersistedState> => JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as Partial<PersistedState>;
const TOKEN_HASH = 'a'.repeat(64);
const presetSubscription = () =>
  localStorage.setItem('hs:app_1', JSON.stringify({ subscriptionId: 'sub_1', userId: 'usr_1', tokenHash: TOKEN_HASH, optedIn: true }));
const init = (hs: ReturnType<typeof createSdk>, extra: Record<string, unknown> = {}) =>
  hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent', webCampaigns: false, ...extra });

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/kampanya?utm_source=facebook&utm_medium=paid&utm_campaign=123&fbclid=FB.1&email=a%40b.com#gizli');
  Object.defineProperty(document, 'referrer', { value: 'https://l.facebook.com/l.php?u=x', configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as { referrer?: string }).referrer;
  history.replaceState(null, '', '/');
});

describe('Attribution (SDK)', () => {
  it('abonelik varsa dokunuş sözleşmeye uygun gövdeyle gönderilir ve first/last okunabilir', async () => {
    presetSubscription();
    const api = fakeApi();
    const hs = createSdk();
    await init(hs);
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(1));
    const body = api.attribution()[0]!.body!;
    const touches = body.touches as AttributionTouch[];
    expect(body).toMatchObject({ subscription_id: 'sub_1', token_hash: TOKEN_HASH });
    expect(body).not.toHaveProperty('external_id');
    expect(touches).toHaveLength(1);
    expect(touches[0]).toEqual({
      touch_id: expect.stringMatching(/^[A-Za-z0-9._:-]{8,64}$/) as string,
      occurred_at: expect.any(String) as string,
      utm_source: 'facebook',
      utm_medium: 'paid',
      utm_campaign: '123',
      click_id_type: 'fbclid',
      click_id: 'FB.1',
      landing_url: `${location.origin}/kampanya`,
      referrer: 'l.facebook.com',
    });
    expect(JSON.stringify(body)).not.toContain('a@b.com');
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));
    const state = hs.Attribution.get();
    expect(state.first).toEqual(touches[0]);
    expect(state.last).toEqual(touches[0]);
    // Çerez yazılmaz; kayıt SDK deposundadır.
    expect(document.cookie).toBe('');
    expect(saved().attribution?.first?.touch_id).toBe(touches[0]!.touch_id);
  });

  it('aynı parametrelerle yeniden yüklemede yeni dokunuş üretilmez; farklı kampanya son dokunuşu günceller', async () => {
    presetSubscription();
    const api = fakeApi();
    await init(createSdk());
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(1));
    const firstId = (api.attribution()[0]!.body!.touches as AttributionTouch[])[0]!.touch_id;

    const reload = createSdk();
    await init(reload);
    await vi.waitFor(() => expect(reload.pendingOperations).toBe(0));
    expect(api.attribution()).toHaveLength(1);

    history.replaceState(null, '', '/urun?utm_source=google&utm_campaign=999&gclid=G1');
    const next = createSdk();
    await init(next);
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(2));
    const state = next.Attribution.get();
    expect(state.first?.touch_id).toBe(firstId);
    expect(state.last).toMatchObject({ utm_source: 'google', utm_campaign: '999', click_id_type: 'gclid', click_id: 'G1' });
  });

  it('windowDays sonrasında kayıt okunurken silinir', async () => {
    presetSubscription();
    fakeApi();
    const hs = createSdk();
    await init(hs, { attribution: { windowDays: 1 } });
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));
    expect(hs.Attribution.get().first).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * DAY);
    expect(hs.Attribution.get()).toEqual({ first: null, last: null });
    expect(saved().attribution).toBeNull();
  });

  it('abonelik ve login yokken dokunuş yerelde bekler; login sonrası external_id ile gönderilir', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await init(hs);
    await vi.waitFor(() => expect(api.calls.some((c) => c.path === '/config')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.attribution()).toHaveLength(0);
    expect(saved().queue?.filter((op) => op.type === 'attribution')).toHaveLength(1);

    await hs.login('user_42', 'hmac_42');
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(1));
    const body = api.attribution()[0]!.body!;
    expect(body).toMatchObject({ external_id: 'user_42', identity_hash: 'hmac_42' });
    expect(body).not.toHaveProperty('subscription_id');
    expect(saved().queue?.some((op) => op.type === 'attribution')).toBe(false);
    // Gönderilen dokunuş bekleyenlerden düşer, first/last raporlama için kalır.
    expect(hs.Attribution.get().last?.utm_source).toBe('facebook');
  });

  it('bekleyen dokunuş e-posta aboneliği oluşunca abonelik kanıtıyla gönderilir', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await init(hs);
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(1));
    const body = api.attribution()[0]!.body!;
    expect(body.subscription_id).toBe('sub_mail');
    expect(body.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('touch_id yeniden denemede ve sayfa yeniden açıldığında aynı kalır', async () => {
    presetSubscription();
    const api = fakeApi({ attributionStatus: [503] });
    await init(createSdk());
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(2), { timeout: 3000 });
    const [a, b] = api.attribution().map((c) => (c.body!.touches as AttributionTouch[])[0]!.touch_id);
    expect(a).toBe(b);

    // Kimliksiz bekleyen dokunuş kalıcıdır: sonraki açılışta özgün kimliğiyle gönderilir.
    localStorage.clear();
    const api2 = fakeApi();
    await init(createSdk());
    await new Promise((r) => setTimeout(r, 20));
    const pending = saved().queue?.find((op) => op.type === 'attribution');
    expect(pending?.type === 'attribution' && pending.touch.touch_id).toBeTruthy();
    localStorage.setItem('hs:app_1', JSON.stringify({ ...saved(), subscriptionId: 'sub_1', tokenHash: TOKEN_HASH, userId: 'usr_1' }));
    await init(createSdk());
    await vi.waitFor(() => expect(api2.attribution()).toHaveLength(1));
    expect((api2.attribution()[0]!.body!.touches as AttributionTouch[])[0]!.touch_id).toBe(
      pending?.type === 'attribution' ? pending.touch.touch_id : '',
    );
  });

  it('gizlilik onayı beklenirken hiçbir şey yakalanmaz/saklanmaz/gönderilmez; onay geri alınınca silinir', async () => {
    presetSubscription();
    const api = fakeApi();
    const hs = createSdk();
    await init(hs, { requiresPrivacyConsent: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.calls).toHaveLength(0);
    expect(saved().attribution ?? null).toBeNull();
    expect(saved().queue ?? []).toHaveLength(0);
    expect(hs.Attribution.get()).toEqual({ first: null, last: null });

    await hs.setConsentGiven(true);
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(1));
    expect(hs.Attribution.get().first).not.toBeNull();

    await hs.setConsentGiven(false);
    expect(saved().attribution).toBeNull();
    expect(hs.Attribution.get()).toEqual({ first: null, last: null });
  });

  it('enabled=false iken hiçbir şey yapılmaz; captureClickIds=false tıklama kimliğini almaz', async () => {
    presetSubscription();
    const api = fakeApi();
    const off = createSdk();
    await init(off, { attribution: { enabled: false } });
    await vi.waitFor(() => expect(off.pendingOperations).toBe(0));
    expect(api.attribution()).toHaveLength(0);
    expect(saved().attribution ?? null).toBeNull();

    const noClick = createSdk();
    await init(noClick, { attribution: { captureClickIds: false } });
    await vi.waitFor(() => expect(api.attribution()).toHaveLength(1));
    const touch = (api.attribution()[0]!.body!.touches as AttributionTouch[])[0]!;
    expect(touch.utm_source).toBe('facebook');
    expect(touch).not.toHaveProperty('click_id');
    expect(touch).not.toHaveProperty('click_id_type');

    history.replaceState(null, '', '/?gclid=G2');
    const onlyClick = createSdk();
    await init(onlyClick, { attribution: { captureClickIds: false } });
    await vi.waitFor(() => expect(onlyClick.pendingOperations).toBe(0));
    expect(api.attribution()).toHaveLength(1);
  });
});

describe('Session.sendEvent eventId (Conversions API tekilleştirmesi)', () => {
  it('verilen event_id piksel kimliğiyle aynı gönderilir; geçersizse SDK üretir', async () => {
    presetSubscription();
    const api = fakeApi();
    const hs = createSdk();
    await init(hs, { attribution: { enabled: false } });
    hs.Session.sendEvent('purchase', { currency: 'TRY' }, 149.9, { eventId: 'pixel-evt-0001' });
    hs.Session.sendEvent('purchase', undefined, 1, { eventId: 'x' });
    await vi.waitFor(() => expect(api.calls.filter((c) => c.path === '/events').length).toBeGreaterThan(0), { timeout: 4000 });
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0), { timeout: 4000 });
    const all = api.calls.filter((c) => c.path === '/events').flatMap((c) => (c.body!.events as { event_id: string }[]).map((e) => e.event_id));
    expect(all).toContain('pixel-evt-0001');
    expect(all).not.toContain('x');
  });
});
