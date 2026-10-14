// @vitest-environment happy-dom
import { digest } from '../core/token.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInAppMessage, type InAppRenderOptions } from '../browser/in-app-render.js';
import { ContactValidationError } from '../core/contact.js';
import type {
  InAppClickEvent,
  InAppMessage,
  InboxChangeEvent,
  PersistedState,
} from '../core/types.js';
import { createSdk } from '../sdk.js';

function message(
  patch: Partial<InAppMessage> = {},
  display: Partial<InAppMessage['display']> = {},
): InAppMessage {
  return {
    id: 'iam_1',
    priority: 0,
    triggers: [],
    remaining_impressions: 1,
    min_interval_seconds: 0,
    last_impression_at: null,
    end_at: null,
    stop_after_interaction: false,
    ...patch,
    display: {
      layout: 'modal',
      background_color: null,
      text_color: null,
      dismissible: true,
      auto_dismiss_seconds: null,
      blocks: [
        { type: 'image', url: 'https://cdn.example.com/sale.png', alt: 'İndirim görseli' },
        { type: 'title', text: '<img src=x onerror="window.__xss=1">Merhaba' },
        { type: 'body', text: 'Sepetin <b>seni</b> bekliyor' },
        {
          type: 'button',
          id: 'go',
          text: 'Sepete git',
          action: { type: 'url', url: 'https://shop.example.com/cart' },
          background_color: '#16a34a',
          text_color: '#ffffff',
        },
        {
          type: 'button',
          id: 'later',
          text: 'Sonra',
          action: { type: 'dismiss' },
          background_color: null,
          text_color: null,
        },
      ],
      ...display,
    },
  };
}

const opened: { close: () => void }[] = [];

function render(m: InAppMessage, patch: Partial<InAppRenderOptions> = {}) {
  const onButton = vi.fn();
  const onDismiss = vi.fn();
  const onAutoDismiss = vi.fn();
  const handle = renderInAppMessage(m, {
    language: 'tr',
    onButton,
    onDismiss,
    onAutoDismiss,
    ...patch,
  });
  opened.push(handle);
  const root = handle.host.shadowRoot!;
  return { handle, root, onButton, onDismiss, onAutoDismiss };
}

const key = (k: string, init: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

afterEach(() => {
  for (const handle of opened.splice(0)) handle.close();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('in-app render (Shadow DOM)', () => {
  it('modal: izole Shadow DOM, textContent ile metin, erişilebilirlik öznitelikleri', () => {
    const { root, handle } = render(
      message({}, { background_color: '#112233', text_color: 'red;x' }),
    );
    expect(document.getElementById('hs-in-app')).toBe(handle.host);
    expect(handle.host.shadowRoot).not.toBeNull();
    // Metin sayfanın light DOM'unda değil, Shadow DOM içinde.
    expect(document.body.textContent).not.toContain('Merhaba');
    const card = root.querySelector('[role="dialog"]')!;
    expect(card.getAttribute('aria-modal')).toBe('true');
    const title = root.querySelector('h2')!;
    expect(card.getAttribute('aria-labelledby')).toBe(title.id);
    // HTML yorumlanmaz: başlıktaki işaretleme düz metin olarak kalır.
    expect(title.textContent).toBe('<img src=x onerror="window.__xss=1">Merhaba');
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.querySelector('p')!.textContent).toBe('Sepetin <b>seni</b> bekliyor');
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('img')!.getAttribute('alt')).toBe('İndirim görseli');
    expect(root.querySelector('style')!.textContent).toContain('prefers-color-scheme:dark');
    // Geçerli renk uygulanır, geçersiz renk yok sayılır.
    expect((card as HTMLElement).style.getPropertyValue('--hs-bg')).toBe('#112233');
    expect((card as HTMLElement).style.getPropertyValue('--hs-fg')).toBe('');
    const go = root.querySelector<HTMLButtonElement>('[data-hs-button-id="go"]')!;
    expect(go.style.getPropertyValue('--hs-btn-bg')).toBe('#16a34a');
    expect(root.querySelector('.hs-close')!.getAttribute('aria-label')).toBe('Kapat');
    expect(root.querySelector('.hs-backdrop')).not.toBeNull();
  });

  it('düğme, ×, Esc ve arka plana tıklama geri çağrıları; karta tıklama kapatmaz', () => {
    const { root, onButton, onDismiss } = render(message());
    root.querySelector<HTMLButtonElement>('[data-hs-button-id="go"]')!.click();
    expect(onButton).toHaveBeenCalledWith(expect.objectContaining({ id: 'go' }));
    root.querySelector<HTMLButtonElement>('.hs-close')!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    key('Escape');
    expect(onDismiss).toHaveBeenCalledTimes(2);
    root.querySelector<HTMLElement>('.hs-card')!.click();
    expect(onDismiss).toHaveBeenCalledTimes(2);
    root.querySelector<HTMLElement>('.hs-backdrop')!.click();
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });

  it('kapatılamaz mesajda kapat düğmesi yok, Esc ve arka plan etkisiz', () => {
    const { root, onDismiss } = render(message({}, { dismissible: false }));
    expect(root.querySelector('.hs-close')).toBeNull();
    key('Escape');
    root.querySelector<HTMLElement>('.hs-backdrop')!.click();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('odak: ilk düğmeye taşınır, Tab mesaj içinde döner, kapatınca önceki öğeye döner', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Sayfa düğmesi';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    const { root, handle } = render(message());
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('button'));
    expect(root.activeElement).toBe(buttons[0]);
    // Son öğede Tab → ilk öğe; ilk öğede Shift+Tab → son öğe.
    buttons[buttons.length - 1]!.focus();
    key('Tab');
    expect(root.activeElement).toBe(buttons[0]);
    key('Tab', { shiftKey: true });
    expect(root.activeElement).toBe(buttons[buttons.length - 1]);
    handle.close();
    expect(document.getElementById('hs-in-app')).toBeNull();
    expect(document.activeElement).toBe(outside);
    handle.close();
  });

  it('banner: sayfayı engellemez, odak çalmaz, auto_dismiss_seconds dolunca kapanır', () => {
    vi.useFakeTimers();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    const { root, onAutoDismiss, onDismiss } = render(
      message({}, { layout: 'banner_bottom', auto_dismiss_seconds: 5 }),
    );
    const card = root.querySelector('[role="dialog"]')!;
    expect(card.getAttribute('aria-modal')).toBe('false');
    expect(card.classList.contains('hs-bottom')).toBe(true);
    expect(root.querySelector('.hs-backdrop')).toBeNull();
    expect(document.activeElement).toBe(outside);
    // Odak banner dışındayken Esc sayfaya aittir.
    key('Escape');
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4999);
    expect(onAutoDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAutoDismiss).toHaveBeenCalledTimes(1);
  });

  it('fullscreen ve güvensiz görsel adresi', () => {
    const { root } = render(
      message(
        {},
        {
          layout: 'fullscreen',
          blocks: [
            { type: 'image', url: 'javascript:alert(1)', alt: null },
            { type: 'title', text: 'Tam ekran' },
          ],
        },
      ),
    );
    expect(root.querySelector('.hs-fullscreen')!.getAttribute('aria-modal')).toBe('true');
    expect(root.querySelector('img')).toBeNull();
  });
});

// --- SDK uçtan uca (sahte API) ---

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const inboxItem = (id: string, read: boolean) => ({
  id,
  message_id: 'msg_1',
  title: `Başlık ${id}`,
  body: 'Gövde',
  url: null,
  image_url: null,
  data: { k: 'v' },
  read,
  read_at: read ? '2026-10-07T10:00:00Z' : null,
  archived_at: null,
  expires_at: null,
  created_at: '2026-10-07T09:00:00Z',
});

function fakeApi(messages: InAppMessage[]) {
  const calls: Call[] = [];
  let loggedIn = false;
  const fetchStub = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace('/sdk/v1/apps/app_1', '');
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const route = `${call.method} ${path}`;
    if (route === 'GET /config')
      return json(200, {
        app_id: 'app_1',
        name: 'Test',
        identity_verification_required: false,
        platforms: { ios: false, android: false, web: true, email: true, sms: true },
        web: { vapid_public_key: null, allowed_origins: [] },
        session: { timeout_seconds: 30 },
      });
    if (route === 'POST /subscriptions') {
      const channel = call.body?.channel as string;
      const linkTo = (call.body?.user as { subscription_id?: string } | undefined)?.subscription_id;
      if (linkTo === 'sub_gone')
        return json(404, { error: { code: 'HS_NOT_FOUND', message: 'Abonelik yok' } });
      return json(200, {
        subscription_id: channel === 'email' ? 'sub_mail' : 'sub_sms',
        user_id: loggedIn ? 'usr_known' : linkTo === 'sub_push' ? 'usr_anon' : 'usr_1',
        external_id: loggedIn ? 'u-42' : null,
        status: 'subscribed',
        created: true,
      });
    }
    if (/^POST \/subscriptions\/[^/]+\/login$/.test(route)) {
      loggedIn = true;
      return json(200, { user_id: 'usr_known', external_id: 'u-42', tags: {} });
    }
    if (/^POST \/subscriptions\/[^/]+\/logout$/.test(route))
      return json(200, { user_id: 'usr_new_anon', external_id: null, tags: {} });
    if (route.startsWith('DELETE /subscriptions/')) return json(200, { ok: true });
    if (route === 'GET /in-app') return json(200, { language: 'tr', data: messages });
    if (route.startsWith('POST /in-app/')) return json(200, { ok: true });
    if (route === 'POST /events' || route === 'POST /sessions') return json(200, { accepted: 1 });
    if (/^GET \/users\/[^/]+\/inbox$/.test(route))
      return json(200, {
        data: call.query.limit === '1' ? [] : [inboxItem('ibx_1', false), inboxItem('ibx_2', true)],
        unread_count: 3,
        next_cursor: 'cur_2',
        has_more: true,
      });
    if (/^POST \/users\/[^/]+\/inbox\/read-all$/.test(route))
      return json(200, { updated: 2, unread_count: 0 });
    if (/^POST \/users\/[^/]+\/inbox\/[^/]+\/read$/.test(route))
      return json(200, { ...inboxItem(path.split('/')[4]!, true) });
    if (/^DELETE \/users\/[^/]+\/inbox\/[^/]+$/.test(route)) return json(200, { ok: true });
    if (route === 'POST /errors') return json(200, { accepted: 0 });
    return json(404, { error: { code: 'HS_NOT_FOUND', message: route } });
  });
  vi.stubGlobal('fetch', fetchStub);
  return {
    calls,
    find: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

/** Kalıcı durumdaki e-posta/SMS abonelikleri. */
const storedContacts = (): PersistedState['contactSubscriptions'] =>
  (JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as Partial<PersistedState>)
    .contactSubscriptions ?? [];

const inAppList: InAppMessage[] = [
  message(
    { id: 'iam_welcome', priority: 1, triggers: [{ kind: 'session_start' }] },
    {
      layout: 'modal',
      blocks: [
        { type: 'title', text: 'Hoş geldin' },
        { type: 'body', text: 'İlk ziyaretin' },
      ],
    },
  ),
  message(
    { id: 'iam_cart_low', priority: 1, triggers: [{ kind: 'event', name: 'cart_viewed' }] },
    { blocks: [{ type: 'title', text: 'Düşük öncelik' }] },
  ),
  message({ id: 'iam_cart', priority: 10, triggers: [{ kind: 'event', name: 'cart_viewed' }] }),
  message(
    {
      id: 'iam_vip',
      priority: 5,
      remaining_impressions: 2,
      triggers: [
        { kind: 'trigger', key: 'vip', op: 'eq', value: 'yes' },
        { kind: 'screen', name: 'pricing' },
      ],
    },
    {
      layout: 'fullscreen',
      blocks: [
        { type: 'title', text: 'VIP' },
        {
          type: 'button',
          id: 'tag',
          text: 'Etiketle',
          action: { type: 'tags', tags: { vip_seen: '1' } },
          background_color: null,
          text_color: null,
        },
      ],
    },
  ),
];

describe('Web SDK: e-posta/SMS, in-app ve inbox (sahte API)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('addEmail/addSms normalize eder, kaydeder, siler; adres düz metin saklanmaz', async () => {
    const api = fakeApi([]);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    expect(() => hs.User.addSms('5321234567')).toThrow(ContactValidationError);
    expect(() => hs.User.addEmail('geçersiz')).toThrow(ContactValidationError);

    hs.User.addEmail('  Ayse.Kaya@Example.COM ');
    hs.User.addSms('0090 (532) 123-45-67');
    await vi.waitFor(() => expect(api.find('POST', '/subscriptions')).toHaveLength(2));
    const [email, sms] = api.find('POST', '/subscriptions');
    expect(email!.body).toMatchObject({
      channel: 'email',
      token: 'ayse.kaya@example.com',
      user: {},
      ownership_proof: true,
    });
    expect(email!.body?.device).toMatchObject({ sdk_platform: 'web' });
    // İkinci adres, cihazın mevcut (e-posta) aboneliği üzerinden aynı anonim kullanıcıya bağlanır.
    // Bağlanan aboneliğin sahiplik kanıtı: kanonik e-posta adresinin özeti (ADR-0016).
    expect(sms!.body).toMatchObject({
      channel: 'sms',
      token: '+905321234567',
      user: { subscription_id: 'sub_mail', token_hash: await digest('ayse.kaya@example.com') },
    });
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));
    const stored = localStorage.getItem('hs:app_1')!;
    expect(stored).not.toContain('ayse.kaya@example.com');
    expect(stored).not.toContain('+905321234567');
    expect(storedContacts()).toHaveLength(2);
    // Push aboneliği yokken kullanıcı e-posta aboneliğinden gelir.
    expect(hs.User.id).toBe('usr_1');

    hs.User.removeEmail('AYSE.KAYA@example.com');
    await vi.waitFor(() => expect(api.find('DELETE', '/subscriptions/sub_mail')).toHaveLength(1));
    // Sahiplik kanıtı (ADR-0016): kanonik adresin SHA-256 özeti; anonim kullanıcıda identity_hash yok.
    expect(api.find('DELETE', '/subscriptions/sub_mail')[0]!.query).toEqual({
      token_hash: await digest('ayse.kaya@example.com'),
    });
    await vi.waitFor(() => expect(storedContacts()).toHaveLength(1));
    hs.destroy();
  });

  it('login olmuş kullanıcıda e-posta external_id + identity_hash ile bağlanır; önceki adres login ile taşınır', async () => {
    const api = fakeApi([]);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));
    const hash = 'a'.repeat(64);
    await hs.login('u-42', hash);
    // identity_hash hedef kullanıcıya aittir; aboneliğin kanıtı adres özetidir (ADR-0016).
    expect(api.find('POST', '/subscriptions/sub_mail/login')[0]!.body).toEqual({
      external_id: 'u-42',
      identity_hash: hash,
      token_hash: await digest('a@example.com'),
    });
    hs.User.addSms('+905320000111');
    await vi.waitFor(() => expect(api.find('POST', '/subscriptions')).toHaveLength(2));
    expect(api.find('POST', '/subscriptions')[1]!.body?.user).toEqual({
      external_id: 'u-42',
      identity_hash: hash,
    });
    hs.destroy();
  });

  it('login yokken adres cihaz aboneliğinin kullanıcısına bağlanır; login aynı kullanıcıyla taşır', async () => {
    const pushHash = await digest('push-token');
    localStorage.setItem(
      'hs:app_1',
      JSON.stringify({ subscriptionId: 'sub_push', userId: 'usr_anon', optedIn: true, tokenHash: pushHash }),
    );
    const api = fakeApi([]);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(storedContacts()).toHaveLength(1));
    // Cihaz aboneliğine bağlama: kanıt kayıtlı push token'ının özetidir.
    expect(api.find('POST', '/subscriptions')[0]!.body?.user).toEqual({
      subscription_id: 'sub_push',
      token_hash: pushHash,
    });
    expect(storedContacts()[0]).toMatchObject({ userId: 'usr_anon', externalId: null });

    // Cihaz aboneliğinin login'i anonim kullanıcıyı (ve e-posta aboneliğini) taşır: ayrı istek yok.
    await hs.login('u-42');
    expect(api.find('POST', '/subscriptions/sub_push/login')).toHaveLength(1);
    expect(api.find('POST', '/subscriptions/sub_push/login')[0]!.body).toEqual({ external_id: 'u-42', token_hash: pushHash });
    expect(api.find('POST', '/subscriptions/sub_mail/login')).toHaveLength(0);
    expect(storedContacts()[0]).toMatchObject({ userId: 'usr_known', externalId: 'u-42' });
    hs.destroy();
  });

  it('oturum olayı ve logout cihaz aboneliğinin sahiplik kanıtını gönderir (ADR-0016)', async () => {
    const pushHash = await digest('push-token');
    const identityHash = 'b'.repeat(64);
    localStorage.setItem(
      'hs:app_1',
      JSON.stringify({
        subscriptionId: 'sub_push',
        userId: 'usr_known',
        externalId: 'u-42',
        identityHash,
        optedIn: true,
        tokenHash: pushHash,
      }),
    );
    const api = fakeApi([]);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await vi.waitFor(() => expect(api.find('POST', '/sessions')).toHaveLength(1));
    expect(api.find('POST', '/sessions')[0]!.body).toMatchObject({
      subscription_id: 'sub_push',
      token_hash: pushHash,
      identity_hash: identityHash,
    });
    await hs.logout();
    expect(api.find('POST', '/subscriptions/sub_push/logout')[0]!.body).toEqual({
      token_hash: pushHash,
      identity_hash: identityHash,
    });
    expect(hs.User.externalId).toBeNull();
    hs.destroy();
  });

  it('push aboneliğinde in-app ve inbox istekleri kayıtlı token özetini kanıt olarak gönderir (ADR-0016)', async () => {
    const pushHash = await digest('push-token');
    const identityHash = 'c'.repeat(64);
    localStorage.setItem(
      'hs:app_1',
      JSON.stringify({
        subscriptionId: 'sub_push',
        userId: 'usr_known',
        externalId: 'u-42',
        identityHash,
        optedIn: true,
        tokenHash: pushHash,
      }),
    );
    const api = fakeApi([]);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await vi.waitFor(() => expect(api.find('GET', '/in-app')).toHaveLength(1));
    expect(api.find('GET', '/in-app')[0]!.query).toEqual({
      subscription_id: 'sub_push',
      token_hash: pushHash,
    });

    await hs.Inbox.list();
    await hs.Inbox.markRead('ibx_1');
    await hs.Inbox.markAllRead();
    await hs.Inbox.archive('ibx_2');
    const proof = { subscription_id: 'sub_push', token_hash: pushHash, identity_hash: identityHash };
    expect(api.find('GET', '/users/usr_known/inbox')[0]!.query).toEqual(proof);
    expect(api.find('POST', '/users/usr_known/inbox/ibx_1/read')[0]!.body).toEqual(proof);
    expect(api.find('POST', '/users/usr_known/inbox/read-all')[0]!.body).toEqual(proof);
    expect(api.find('DELETE', '/users/usr_known/inbox/ibx_2')[0]!.query).toEqual(proof);
    hs.destroy();
  });

  it('cihaz aboneliği sunucuda yoksa (404) adres bağlamasız yeniden kaydedilir', async () => {
    localStorage.setItem(
      'hs:app_1',
      JSON.stringify({ subscriptionId: 'sub_gone', userId: 'usr_x', optedIn: true }),
    );
    const api = fakeApi([]);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addSms('+905320000111');
    await vi.waitFor(() => expect(storedContacts()).toHaveLength(1));
    expect(api.find('POST', '/subscriptions').map((c) => c.body?.user)).toEqual([
      { subscription_id: 'sub_gone' },
      {},
    ]);
    hs.destroy();
  });

  it("in-app: oturum başı, olay, tetik ve ekran koşulları; öncelik; olaylar API'ye gider", async () => {
    const api = fakeApi(inAppList);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const hs = createSdk();
    const clicks: InAppClickEvent[] = [];
    const lifecycle: string[] = [];
    hs.InAppMessages.addClickListener((e) => clicks.push(e));
    hs.InAppMessages.addLifecycleListener({
      willDisplay: (e) => lifecycle.push(`will:${e.message.id}`),
      didDisplay: (e) => lifecycle.push(`did:${e.message.id}`),
      didDismiss: (e) => lifecycle.push(`dismissed:${e.message.id}`),
    });
    await hs.init({
      appId: 'app_1',
      apiUrl: 'https://api.test',
      logLevel: 'silent',
      language: 'tr',
    });
    // Abonelik yokken in-app çalışmaz.
    expect(api.find('GET', '/in-app')).toHaveLength(0);
    hs.User.addEmail('a@example.com');

    // Abonelik oluşunca liste alınır ve bekleyen oturum başı koşulu değerlendirilir.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-hs-message-id="iam_welcome"]')).not.toBeNull(),
    );
    // E-posta aboneliğinin sahiplik kanıtı (kanonik adresin özeti) liste ve olaylarla gönderilir (ADR-0016).
    const mailHash = await digest('a@example.com');
    expect(api.find('GET', '/in-app')[0]!.query).toEqual({
      subscription_id: 'sub_mail',
      token_hash: mailHash,
    });
    await vi.waitFor(() =>
      expect(api.find('POST', '/in-app/iam_welcome/events')[0]?.body).toEqual({
        subscription_id: 'sub_mail',
        token_hash: mailHash,
        type: 'impression',
      }),
    );
    expect(lifecycle).toEqual(['will:iam_welcome', 'did:iam_welcome']);

    // × ile kapatma → dismiss olayı.
    const welcome = document.getElementById('hs-in-app')!.shadowRoot!;
    welcome.querySelector<HTMLButtonElement>('.hs-close')!.click();
    expect(document.getElementById('hs-in-app')).toBeNull();
    await vi.waitFor(() =>
      expect(api.find('POST', '/in-app/iam_welcome/events').map((c) => c.body?.type)).toEqual([
        'impression',
        'dismiss',
      ]),
    );

    // Olay tetiği: iki uygun mesajdan önceliği yüksek olan gösterilir.
    hs.Session.sendEvent('cart_viewed');
    await vi.waitFor(() =>
      expect(document.querySelector('[data-hs-message-id="iam_cart"]')).not.toBeNull(),
    );
    const cart = document.getElementById('hs-in-app')!.shadowRoot!;
    cart.querySelector<HTMLButtonElement>('[data-hs-button-id="go"]')!.click();
    expect(clicks).toEqual([
      {
        message: { id: 'iam_cart' },
        result: { actionId: 'go', url: 'https://shop.example.com/cart' },
      },
    ]);
    expect(open).toHaveBeenCalledWith(
      'https://shop.example.com/cart',
      '_blank',
      'noopener,noreferrer',
    );
    // Tıklamadan sonra mesaj kapanır; aynı anda tek mesaj gösterildiği için düşük öncelikli açılmaz.
    expect(document.getElementById('hs-in-app')).toBeNull();
    await vi.waitFor(() =>
      expect(api.find('POST', '/in-app/iam_cart/events').map((c) => c.body)).toEqual([
        { subscription_id: 'sub_mail', token_hash: mailHash, type: 'impression' },
        { subscription_id: 'sub_mail', token_hash: mailHash, type: 'click', button_id: 'go' },
      ]),
    );

    // Aynı olay tekrar: yüksek öncelikli mesajın hakkı bitti (yerel sayaç), sıradaki gösterilir.
    hs.Session.sendEvent('cart_viewed');
    await vi.waitFor(() =>
      expect(document.querySelector('[data-hs-message-id="iam_cart_low"]')).not.toBeNull(),
    );
    key('Escape');
    expect(document.getElementById('hs-in-app')).toBeNull();
    hs.Session.sendEvent('cart_viewed');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById('hs-in-app')).toBeNull();

    // Tetik + ekran koşulu birlikte sağlanmalı.
    hs.InAppMessages.addTrigger('vip', 'yes');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById('hs-in-app')).toBeNull();
    expect(hs.InAppMessages.getTriggers()).toEqual({ vip: 'yes' });
    hs.InAppMessages.paused = true;
    hs.InAppMessages.setScreen('pricing');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById('hs-in-app')).toBeNull();
    hs.InAppMessages.paused = false;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-hs-message-id="iam_vip"]')).not.toBeNull(),
    );
    // `tags` aksiyonu kullanıcı etiketlerini yazar.
    document
      .getElementById('hs-in-app')!
      .shadowRoot!.querySelector<HTMLButtonElement>('[data-hs-button-id="tag"]')!
      .click();
    await vi.waitFor(() =>
      expect(api.calls.some((c) => c.method === 'PATCH' && c.path === '/users/usr_1')).toBe(true),
    );
    expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/users/usr_1')!.body).toEqual({
      tags: { vip_seen: '1' },
    });
    hs.InAppMessages.clearTriggers();
    expect(hs.InAppMessages.getTriggers()).toEqual({});
    hs.destroy();
  });

  it('stop_after_interaction: kapatma/tıklama sonrası liste yenilenmeden tekrar gösterilmez', async () => {
    const list = [
      message({
        id: 'iam_stop',
        remaining_impressions: 5,
        stop_after_interaction: true,
        triggers: [{ kind: 'event', name: 'stop_evt' }],
      }),
      message({
        id: 'iam_repeat',
        remaining_impressions: 5,
        triggers: [{ kind: 'event', name: 'repeat_evt' }],
      }),
    ];
    const api = fakeApi(list);
    vi.spyOn(window, 'open').mockImplementation(() => null);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(api.find('GET', '/in-app')).toHaveLength(1));
    const shown = (id: string) => document.querySelector(`[data-hs-message-id="${id}"]`) !== null;

    // Kapatma (×) etkileşimdir: aynı olay tekrar gelse de mesaj açılmaz.
    hs.Session.sendEvent('stop_evt');
    await vi.waitFor(() => expect(shown('iam_stop')).toBe(true));
    document
      .getElementById('hs-in-app')!
      .shadowRoot!.querySelector<HTMLButtonElement>('.hs-close')!
      .click();
    hs.Session.sendEvent('stop_evt');
    await new Promise((r) => setTimeout(r, 20));
    expect(shown('iam_stop')).toBe(false);
    expect(api.find('GET', '/in-app')).toHaveLength(1);

    // Bayrak kapalı mesaj, hakkı kaldıkça tıklamadan sonra yeniden gösterilir.
    hs.Session.sendEvent('repeat_evt');
    await vi.waitFor(() => expect(shown('iam_repeat')).toBe(true));
    document
      .getElementById('hs-in-app')!
      .shadowRoot!.querySelector<HTMLButtonElement>('[data-hs-button-id="go"]')!
      .click();
    hs.Session.sendEvent('repeat_evt');
    await vi.waitFor(() => expect(shown('iam_repeat')).toBe(true));
    // Olaylar artık e-posta aboneliğiyle gönderilir: test bitmeden kuyruk boşalsın (sahte fetch kaldırılmadan).
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));
    hs.destroy();
  });

  it('inbox: liste, okundu, tümünü okundu, arşiv, okunmamış sayısı ve gözlemci', async () => {
    const api = fakeApi([]);
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent' });
    await expect(hs.Inbox.list()).rejects.toThrow(/kullanıcı veya abonelik yok/);
    hs.User.addEmail('a@example.com');
    await vi.waitFor(() => expect(hs.pendingOperations).toBe(0));

    const events: InboxChangeEvent[] = [];
    hs.Inbox.addObserver((e) => events.push(e));
    const page = await hs.Inbox.list({ limit: 10 });
    // Tüm inbox isteklerinde aboneliğin sahiplik kanıtı (ADR-0016) gönderilir.
    const mailHash = await digest('a@example.com');
    expect(api.find('GET', '/users/usr_1/inbox')[0]!.query).toEqual({
      subscription_id: 'sub_mail',
      token_hash: mailHash,
      limit: '10',
    });
    expect(page).toMatchObject({ unreadCount: 3, nextCursor: 'cur_2', hasMore: true });
    expect(page.items[0]).toEqual({
      id: 'ibx_1',
      messageId: 'msg_1',
      title: 'Başlık ibx_1',
      body: 'Gövde',
      url: null,
      imageUrl: null,
      data: { k: 'v' },
      read: false,
      readAt: null,
      archivedAt: null,
      expiresAt: null,
      createdAt: '2026-10-07T09:00:00Z',
    });

    const item = await hs.Inbox.markRead('ibx_1');
    expect(item.read).toBe(true);
    expect(api.find('POST', '/users/usr_1/inbox/ibx_1/read')[0]!.body).toEqual({
      subscription_id: 'sub_mail',
      token_hash: mailHash,
    });
    await hs.Inbox.archive('ibx_2');
    expect(api.find('DELETE', '/users/usr_1/inbox/ibx_2')[0]!.query).toEqual({
      subscription_id: 'sub_mail',
      token_hash: mailHash,
    });
    expect(await hs.Inbox.markAllRead()).toEqual({ updated: 2, unreadCount: 0 });
    expect(await hs.Inbox.unreadCount()).toBe(3);
    expect(api.find('GET', '/users/usr_1/inbox')[1]!.query).toMatchObject({ limit: '1' });
    expect(events.map((e) => [e.type, e.unreadCount])).toEqual([
      ['listed', 3],
      ['read', 2],
      ['archived', 2],
      ['read_all', 0],
      ['count', 3],
    ]);

    // Login'de verilen identity_hash inbox isteklerine eklenir.
    const hash = 'b'.repeat(64);
    await hs.login('u-42', hash);
    await hs.Inbox.markAllRead();
    expect(api.find('POST', '/users/usr_known/inbox/read-all')[0]!.body).toEqual({
      subscription_id: 'sub_mail',
      token_hash: mailHash,
      identity_hash: hash,
    });
    hs.destroy();
  });
});
