// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectsContact, showSlidedown, slidedownFromRemote } from '../browser/prompts.js';
import { digest } from '../core/token.js';
import type { InAppMessage, PersistedState } from '../core/types.js';
import { createSdk } from '../sdk.js';

/**
 * Faz 12 / ADR-0019 Web SDK davranışları: in-app tetik grupları, oturum süresi, A/B varyantı,
 * app geneli aralık, push_prompt/outcome aksiyonları, tercih API'si, e-posta/SMS toplama istemi ve
 * `pagehide` oturum bitişi (keepalive).
 */

function message(patch: Partial<InAppMessage> = {}, blocks?: InAppMessage['display']['blocks']): InAppMessage {
  return {
    id: 'iam_1',
    priority: 0,
    triggers: [],
    remaining_impressions: 5,
    min_interval_seconds: 0,
    last_impression_at: null,
    end_at: null,
    stop_after_interaction: false,
    variant_id: null,
    display: {
      layout: 'modal',
      background_color: null,
      text_color: null,
      dismissible: true,
      auto_dismiss_seconds: null,
      blocks: blocks ?? [
        { type: 'title', text: 'Merhaba' },
        { type: 'button', id: 'ok', text: 'Tamam', action: { type: 'dismiss' }, background_color: null, text_color: null },
      ],
    },
    ...patch,
  };
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
  keepalive: boolean | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface FakeOptions {
  messages?: InAppMessage[];
  minIntervalSeconds?: number;
  prompt?: Record<string, unknown> | null;
}

function fakeApi(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  let loggedIn = false;
  const categories = [
    { key: 'promo', name: { tr: 'Kampanyalar', en: 'Promotions' }, description: {}, channels: null, default_opted_in: true },
    { key: 'news', name: { tr: 'Haberler', en: 'News' }, description: { tr: 'Haftalık' }, channels: ['email'], default_opted_in: false },
  ];
  const fetchStub = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace('/sdk/v1/apps/app_1', '');
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      keepalive: init?.keepalive,
    };
    calls.push(call);
    const route = `${call.method} ${path}`;
    if (route === 'GET /config')
      return json(200, {
        app_id: 'app_1',
        name: 'Test',
        identity_verification_required: false,
        platforms: { ios: false, android: false, web: true, email: true, sms: true },
        web: { vapid_public_key: null, allowed_origins: [], prompt: opts.prompt ?? null },
        session: { timeout_seconds: 30 },
        in_app: { min_interval_seconds: opts.minIntervalSeconds ?? 0 },
        android_channels: [],
        categories,
      });
    if (route === 'POST /subscriptions') {
      const channel = call.body?.channel as string;
      return json(200, {
        subscription_id: channel === 'email' ? 'sub_mail' : 'sub_sms',
        user_id: loggedIn ? 'usr_known' : 'usr_1',
        external_id: loggedIn ? 'u-42' : null,
        status: 'subscribed',
        created: true,
      });
    }
    if (/^POST \/subscriptions\/[^/]+\/login$/.test(route)) {
      loggedIn = true;
      return json(200, { user_id: 'usr_known', external_id: 'u-42', tags: {} });
    }
    if (route === 'GET /in-app') return json(200, { language: 'tr', data: opts.messages ?? [] });
    if (route.startsWith('POST /in-app/')) return json(200, { ok: true });
    if (route === 'POST /events' || route === 'POST /sessions') return json(200, { accepted: 1 });
    if (route === 'GET /preferences' || route === 'PUT /preferences')
      return json(200, {
        data: [
          { category: 'promo', channel: null, opted_in: route.startsWith('PUT') ? false : true, explicit: route.startsWith('PUT'), source: route.startsWith('PUT') ? 'sdk' : null, updated_at: null },
          { category: 'news', channel: 'email', opted_in: false, explicit: false, source: null, updated_at: null },
        ],
        categories,
      });
    if (route === 'POST /errors') return json(200, { accepted: 0 });
    return json(404, { error: { code: 'HS_NOT_FOUND', message: route } });
  });
  vi.stubGlobal('fetch', fetchStub);
  return {
    calls,
    find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}

const stored = () => JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as PersistedState;
const shown = (id: string) => document.querySelector(`[data-hs-message-id="${id}"]`) !== null;
const shadow = () => document.getElementById('hs-in-app')!.shadowRoot!;
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

describe('in-app: A/B varyantı, app geneli aralık ve tetik grupları', () => {
  it('variant_id her olayla geri gider; app geneli min_interval_seconds dolmadan başka mesaj gösterilmez', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 8, 12));
    const api = fakeApi({
      minIntervalSeconds: 60,
      messages: [
        message({ id: 'iam_a', variant_id: 'var_b', triggers: [{ kind: 'event', name: 'e1' }] }),
        message({
          id: 'iam_b',
          triggers: [{ kind: 'event', name: 'never' }],
          trigger_groups: [[{ kind: 'event', name: 'never' }], [{ kind: 'event', name: 'e2' }, { kind: 'screen', name: 'cart' }]],
        }),
      ],
    });
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(api.find('GET', '/in-app')).toHaveLength(1));
    // E-posta aboneliğinin sahiplik kanıtı (kanonik adresin özeti) liste ve olay isteklerine eklenir.
    const mailHash = await digest('a@example.com');
    expect(api.find('GET', '/in-app')[0]!.query).toEqual({ subscription_id: 'sub_mail', token_hash: mailHash });

    hs.Session.sendEvent('e1');
    await vi.waitFor(() => expect(shown('iam_a')).toBe(true));
    await vi.waitFor(() =>
      expect(api.find('POST', '/in-app/iam_a/events')[0]?.body).toEqual({
        subscription_id: 'sub_mail',
        token_hash: mailHash,
        type: 'impression',
        variant_id: 'var_b',
      }),
    );
    expect(stored().inAppLastImpressionAt).toBeGreaterThan(0);
    shadow().querySelector<HTMLButtonElement>('[data-hs-button-id="ok"]')!.click();
    await vi.waitFor(() =>
      expect(api.find('POST', '/in-app/iam_a/events')[1]?.body).toEqual({
        subscription_id: 'sub_mail',
        token_hash: mailHash,
        type: 'click',
        button_id: 'ok',
        variant_id: 'var_b',
      }),
    );

    // Tetik grupları: ilk grup (never) sağlanmaz, ikinci grup event + screen ister.
    hs.InAppMessages.setScreen('cart');
    hs.Session.sendEvent('e2');
    await tick();
    // App geneli aralık (60 sn) dolmadı: uygun olsa da gösterilmez.
    expect(shown('iam_b')).toBe(false);
    vi.setSystemTime(Date.now() + 61_000);
    hs.Session.sendEvent('e2');
    await vi.waitFor(() => expect(shown('iam_b')).toBe(true));
    // Varyantı olmayan mesajın olayında variant_id yok.
    await vi.waitFor(() =>
      expect(api.find('POST', '/in-app/iam_b/events')[0]?.body).toEqual({
        subscription_id: 'sub_mail',
        token_hash: mailHash,
        type: 'impression',
      }),
    );
    hs.destroy();
  });

  it('session_duration tetiği oturum süresi dolunca zamanlayıcıyla gösterilir', async () => {
    const api = fakeApi({
      messages: [message({ id: 'iam_dur', triggers: [], trigger_groups: [[{ kind: 'session_duration', seconds: 1 }]] })],
    });
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(api.find('GET', '/in-app')).toHaveLength(1));
    expect(shown('iam_dur')).toBe(false);
    await vi.waitFor(() => expect(shown('iam_dur')).toBe(true), { timeout: 3000 });
    hs.destroy();
  });

  it('push_prompt aksiyonu izin istemini açar, outcome aksiyonu olay gönderir; ikisi de mesajı kapatır', async () => {
    const api = fakeApi({
      messages: [
        message({ id: 'iam_act', triggers: [{ kind: 'event', name: 'go' }] }, [
          { type: 'title', text: 'Aksiyonlar' },
          { type: 'button', id: 'perm', text: 'Bildirim aç', action: { type: 'push_prompt' }, background_color: null, text_color: null },
          { type: 'button', id: 'buy', text: 'Satın al', action: { type: 'outcome', name: 'signup', value: 3 }, background_color: null, text_color: null },
        ]),
      ],
    });
    const hs = createSdk();
    const requestPermission = vi.spyOn(hs.Notifications, 'requestPermission').mockResolvedValue('denied');
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(api.find('GET', '/in-app')).toHaveLength(1));
    // Olaylar push aboneliği ya da external_id ister (mevcut kural): login ile kimlik verilir.
    await hs.login('u-42');

    hs.Session.sendEvent('go');
    await vi.waitFor(() => expect(shown('iam_act')).toBe(true));
    shadow().querySelector<HTMLButtonElement>('[data-hs-button-id="perm"]')!.click();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(document.getElementById('hs-in-app')).toBeNull();

    hs.Session.sendEvent('go');
    await vi.waitFor(() => expect(shown('iam_act')).toBe(true));
    shadow().querySelector<HTMLButtonElement>('[data-hs-button-id="buy"]')!.click();
    expect(document.getElementById('hs-in-app')).toBeNull();
    await vi.waitFor(() => {
      const events = api.find('POST', '/events').flatMap((c) => c.body?.events as { name: string; value?: number }[]);
      expect(events).toContainEqual(expect.objectContaining({ name: 'signup', value: 3 }));
    });
    hs.destroy();
  });
});

describe('kullanıcı tercihleri (User.getPreferences / setPreferences)', () => {
  it('abonelik kanıtıyla okur ve yazar; login sonrası identity_hash eklenir; çevrimdışı kuyruğa girer', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    expect(hs.User.getCategories()).toEqual([
      { key: 'promo', name: { tr: 'Kampanyalar', en: 'Promotions' }, description: {}, channels: null, defaultOptedIn: true },
      { key: 'news', name: { tr: 'Haberler', en: 'News' }, description: { tr: 'Haftalık' }, channels: ['email'], defaultOptedIn: false },
    ]);
    await expect(hs.User.getPreferences()).rejects.toThrow(/abonelik gerekli/);
    expect(() => hs.User.setPreferences([])).toThrow(/1-100/);
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));

    // Çevrimdışı: tercih kuyrukta bekler, bağlantı gelince gönderilir.
    const online = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503, headers: { 'retry-after': '0.001' } })),
    );
    hs.User.setPreferences([{ category: 'promo', optedIn: false }, { category: 'news', optedIn: true, channel: 'email' }]);
    expect(stored().queue.some((op) => op.type === 'preferences')).toBe(true);
    // Yeniden denemeler tükenene kadar bekle; işlem kuyrukta kalır.
    await tick(50);
    expect(stored().queue.some((op) => op.type === 'preferences')).toBe(true);
    expect(api.find('PUT', '/preferences')).toHaveLength(0);
    vi.stubGlobal('fetch', online);
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(api.find('PUT', '/preferences')).toHaveLength(1));
    const hash = await digest('a@example.com');
    expect(api.find('PUT', '/preferences')[0]!.body).toEqual({
      subscription_id: 'sub_mail',
      token_hash: hash,
      preferences: [
        { category: 'promo', opted_in: false },
        { category: 'news', opted_in: true, channel: 'email' },
      ],
    });

    const prefs = await hs.User.getPreferences();
    expect(api.find('GET', '/preferences')[0]!.query).toEqual({ subscription_id: 'sub_mail', token_hash: hash });
    expect(prefs.preferences[0]).toEqual({ category: 'promo', channel: null, optedIn: true, explicit: false, source: null, updatedAt: null });
    expect(prefs.preferences[1]).toMatchObject({ category: 'news', channel: 'email', optedIn: false });
    expect(prefs.categories.map((c) => c.key)).toEqual(['promo', 'news']);

    const identityHash = 'c'.repeat(64);
    await hs.login('u-42', identityHash);
    await hs.User.getPreferences();
    expect(api.find('GET', '/preferences')[1]!.query).toEqual({ subscription_id: 'sub_mail', token_hash: hash, identity_hash: identityHash });
    hs.destroy();
  });
});

describe('e-posta/SMS toplama istemi (slidedown collect)', () => {
  const slidedown = () => document.querySelector<HTMLElement>('.hs-slidedown');

  it('collect: email alan + doğrulama; kabulde User.addEmail ve istem bir daha gösterilmez', async () => {
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent', language: 'tr', slidedown: { enabled: true, collect: 'email' } });
    await vi.waitFor(() => expect(slidedown()).not.toBeNull());
    const box = slidedown()!;
    expect(box.getAttribute('data-hs-collect')).toBe('email');
    expect(box.querySelector('h3')!.textContent).toBe('Haberdar olmak ister misiniz?');
    const input = box.querySelector<HTMLInputElement>('input[name="hs-email"]')!;
    expect(box.querySelector('input[name="hs-sms"]')).toBeNull();

    // Geçersiz adres: hata gösterilir, kutu kapanmaz, kayıt gitmez.
    input.value = 'gecersiz';
    box.querySelector<HTMLButtonElement>('.hs-accept')!.click();
    expect(slidedown()).not.toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(box.querySelector('.hs-error')!.textContent).toContain('e-posta');
    expect(api.find('POST', '/subscriptions')).toHaveLength(0);

    input.value = '  Ayse@Example.COM ';
    box.querySelector<HTMLButtonElement>('.hs-accept')!.click();
    expect(slidedown()).toBeNull();
    await vi.waitFor(() => expect(api.find('POST', '/subscriptions')).toHaveLength(1));
    expect(api.find('POST', '/subscriptions')[0]!.body).toMatchObject({ channel: 'email', token: 'ayse@example.com' });
    expect(stored().contactPromptAnswered).toBe(true);
    // Yanıtlandı: force ile bile yeniden gösterilmez.
    await hs.Slidedown.promptEmail({ force: true });
    expect(slidedown()).toBeNull();
    hs.destroy();
  });

  it('reddedilen e-posta/SMS istemi push istemiyle aynı takvimle geri çekilir; force takvimi atlar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const api = fakeApi({ prompt: { enabled: true, type: 'slidedown', collect: 'email_sms', texts: { en: { title: 'Join us' } } } });
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent', language: 'en' });
    // Dashboard istemi `collect: email_sms` → iki alan.
    await vi.waitFor(() => expect(slidedown()).not.toBeNull());
    expect(slidedown()!.getAttribute('data-hs-collect')).toBe('email_sms');
    expect(slidedown()!.querySelector('h3')!.textContent).toBe('Join us');
    expect(slidedown()!.querySelector('input[name="hs-email"]')).not.toBeNull();
    expect(slidedown()!.querySelector('input[name="hs-sms"]')).not.toBeNull();
    slidedown()!.querySelector<HTMLButtonElement>('.hs-cancel')!.click();
    await vi.waitFor(() => expect(stored().contactPromptDismissCount).toBe(1));
    expect(stored().promptDismissCount).toBe(0);

    // 3 gün dolmadan gösterilmez; dolunca gösterilir; force takvimi atlar.
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    await hs.Slidedown.promptSms();
    expect(slidedown()).toBeNull();
    const forced = hs.Slidedown.promptSms({ force: true });
    await vi.waitFor(() => expect(slidedown()).not.toBeNull());
    expect(slidedown()!.getAttribute('data-hs-collect')).toBe('sms');
    const sms = slidedown()!.querySelector<HTMLInputElement>('input[name="hs-sms"]')!;
    sms.value = '0090 (532) 123 45 67';
    sms.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await forced;
    expect(slidedown()).toBeNull();
    expect(stored().contactPromptAnswered).toBe(true);
    await vi.waitFor(() => expect(api.find('POST', '/subscriptions')).toHaveLength(1));
    expect(api.find('POST', '/subscriptions')[0]!.body).toMatchObject({ channel: 'sms', token: '+905321234567' });
    hs.destroy();
  });

  it('push slidedown değişmedi: collect yokken alan çizilmez ve kabul izin istemine gider', async () => {
    const pending = showSlidedown({}, 'tr');
    const box = slidedown()!;
    expect(box.getAttribute('data-hs-collect')).toBe('push');
    expect(box.querySelector('.hs-field')).toBeNull();
    expect(box.querySelector('h3')!.textContent).toBe('Bildirimleri açmak ister misiniz?');
    box.querySelector<HTMLButtonElement>('.hs-accept')!.click();
    await expect(pending).resolves.toEqual({ accepted: true, tags: {} });
    expect(collectsContact(undefined)).toBe(false);
    expect(collectsContact('push')).toBe(false);
    expect(collectsContact('sms')).toBe(true);
    expect(slidedownFromRemote({ enabled: true, type: 'slidedown', collect: 'email' }, 'tr').collect).toBe('email');
  });
});

describe('oturum bitişi', () => {
  it('pagehide anında duration_seconds keepalive fetch ile eşzamanlı gönderilir', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 8, 12));
    const pushHash = await digest('push-token');
    localStorage.setItem('hs:app_1', JSON.stringify({ subscriptionId: 'sub_push', userId: 'usr_1', optedIn: true, tokenHash: pushHash }));
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await vi.waitFor(() => expect(api.find('POST', '/sessions')).toHaveLength(1));
    expect(api.find('POST', '/sessions')[0]!.body).not.toHaveProperty('duration_seconds');

    vi.setSystemTime(Date.now() + 42_000);
    window.dispatchEvent(new Event('pagehide'));
    // Kuyruk/flush beklenmez: istek olay işleyicisi içinde başlatılmış olmalı.
    const end = api.find('POST', '/sessions')[1]!;
    expect(end.keepalive).toBe(true);
    expect(end.body).toMatchObject({ subscription_id: 'sub_push', duration_seconds: 42, token_hash: pushHash });
    hs.destroy();
  });

  it('oturum bitişi geçici hatada kuyruğa yazılır', async () => {
    const pushHash = await digest('push-token');
    localStorage.setItem('hs:app_1', JSON.stringify({ subscriptionId: 'sub_push', userId: 'usr_1', optedIn: true, tokenHash: pushHash }));
    const api = fakeApi();
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await vi.waitFor(() => expect(api.find('POST', '/sessions')).toHaveLength(1));
    // 503 + kısa retry-after: yeniden denemeler hızla tükenir, işlem kuyruğa düşer.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503, headers: { 'retry-after': '0.001' } })),
    );
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() =>
      expect(stored().queue.some((op) => op.type === 'session_end' && op.durationSeconds >= 0)).toBe(true),
    );
    hs.destroy();
  });
});
