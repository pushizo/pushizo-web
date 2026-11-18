// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InAppManager, type InAppRenderer } from '../browser/in-app.js';
import { ContactValidationError } from '../core/contact.js';
import { Logger } from '../core/logger.js';
import type { InAppMessage, QueuedOperation } from '../core/types.js';
import { createSdk } from '../sdk.js';

/** İstemci SDK'ları API eşitliği: Web'e eklenen Android/iOS karşılıkları. */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CONFIG = { app_id: 'app_1', name: 'A', identity_verification_required: false, identity_verification_mode: 'off', platforms: {}, web: { vapid_public_key: null, allowed_origins: [] }, session: { timeout_seconds: 30 } };

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

function stubServer(routes: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/sdk\/v1\/apps\/app_1/, ''),
        query: url.searchParams,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      };
      calls.push(call);
      if (call.path === '/config') return json(200, { ...CONFIG, api_url: url.origin });
      return routes(call) ?? json(200, {});
    }),
  );
  return calls;
}

const start = async () => {
  const sdk = createSdk();
  await sdk.init({ appId: 'app_1', apiUrl: 'https://api.example.com', webCampaigns: false, webPersonalization: false });
  return sdk;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Notifications: dinleyici kaldırma ve rozet', () => {
  it('removeClickListener / removeForegroundLifecycleListener dinleyiciyi kaldırır', async () => {
    stubServer();
    const sdk = await start();
    const click = vi.fn();
    const foreground = vi.fn();
    sdk.Notifications.addClickListener(click);
    sdk.Notifications.addForegroundLifecycleListener(foreground);
    const internals = sdk as unknown as { clickListeners: Set<unknown>; foregroundListeners: Set<unknown> };
    expect(internals.clickListeners.has(click)).toBe(true);
    expect(internals.foregroundListeners.has(foreground)).toBe(true);
    sdk.Notifications.removeClickListener(click);
    sdk.Notifications.removeForegroundLifecycleListener(foreground);
    expect(internals.clickListeners.size).toBe(0);
    expect(internals.foregroundListeners.size).toBe(0);
  });

  it('setBadgeCount: App Badging API varsa uygular, yoksa false', async () => {
    stubServer();
    const sdk = await start();
    expect(await sdk.Notifications.setBadgeCount(3)).toBe(false);
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    try {
      expect(await sdk.Notifications.setBadgeCount(3.7)).toBe(true);
      expect(setAppBadge).toHaveBeenCalledWith(3);
      expect(await sdk.Notifications.clearBadge()).toBe(true);
      expect(clearAppBadge).toHaveBeenCalledTimes(1);
      expect(await sdk.Notifications.setBadgeCount(Number.NaN)).toBe(false);
      setAppBadge.mockRejectedValueOnce(new Error('NotAllowedError'));
      expect(await sdk.Notifications.setBadgeCount(1)).toBe(false);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).setAppBadge;
      delete (navigator as unknown as Record<string, unknown>).clearAppBadge;
    }
  });
});

describe('FeatureFlags.removeObserver', () => {
  it('kaldırılan gözlemci çağrılmaz', async () => {
    stubServer((c) => (c.path === '/feature-flags/evaluate' ? json(200, { flags: { a: { enabled: true, value: 1 } } }) : undefined));
    const sdk = await start();
    const listener = vi.fn();
    sdk.FeatureFlags.addObserver(listener);
    await sdk.FeatureFlags.refresh();
    const seen = listener.mock.calls.length;
    expect(seen).toBeGreaterThan(0);
    sdk.FeatureFlags.removeObserver(listener);
    await sdk.FeatureFlags.refresh();
    expect(listener).toHaveBeenCalledTimes(seen);
  });
});

describe('Profille login', () => {
  it('geçersiz profil girişten önce reddedilir (istek gitmez)', async () => {
    const calls = stubServer();
    const sdk = await start();
    const before = calls.length;
    await expect(sdk.login('user_42', undefined, { email: 'bozuk' })).rejects.toBeInstanceOf(ContactValidationError);
    await expect(sdk.login('user_42', undefined, { sms: '0532' })).rejects.toBeInstanceOf(ContactValidationError);
    await expect(sdk.login('user_42', undefined, { aliases: { external_id: 'x' } })).rejects.toThrow(/alias/);
    expect(calls.length).toBe(before);
    expect(sdk.User.externalId).toBeNull();
  });

  it('giriş sonrası e-posta, SMS, tag ve alias tek çağrıda ayarlanır', async () => {
    const calls = stubServer((c) => {
      if (c.method === 'POST' && c.path === '/subscriptions')
        return json(201, { subscription_id: `sub_${String(c.body.channel)}`, user_id: 'usr_1', external_id: 'user_42', opted_in: true });
      if (c.method === 'PATCH' && c.path === '/users/usr_1') return json(200, { user_id: 'usr_1', external_id: 'user_42', tags: { plan: 'pro' } });
      return undefined;
    });
    const sdk = await start();
    await sdk.login('user_42', undefined, { email: 'Ali@Ornek.com', sms: '+905321234567', tags: { plan: 'pro' }, aliases: { crm_id: '42' } });
    expect(sdk.User.externalId).toBe('user_42');
    // Profil işlemleri kalıcı kuyruktan sırayla gönderilir.
    await vi.waitFor(() => expect(sdk.pendingOperations).toBe(0));
    const contacts = calls.filter((c) => c.method === 'POST' && c.path === '/subscriptions');
    expect(contacts.map((c) => [c.body.channel, c.body.token])).toEqual([
      ['email', 'ali@ornek.com'],
      ['sms', '+905321234567'],
    ]);
    const patch = (path: string) => calls.filter((c) => c.method === 'PATCH' && c.path === path).map((c) => c.body);
    expect(patch('/users/usr_1')).toEqual([{ tags: { plan: 'pro' } }]);
    expect(patch('/users/usr_1/identity')).toEqual([{ identity: { crm_id: '42' } }]);
  });
});

describe('Location.permissionGranted', () => {
  it('Permissions API durumunu istem açmadan yansıtır', async () => {
    stubServer();
    const query = vi.fn(async () => ({ state: 'granted' }));
    vi.stubGlobal('navigator', { ...navigator, language: 'tr', userAgent: 'x', onLine: true, geolocation: { getCurrentPosition: vi.fn() }, permissions: { query } });
    const sdk = await start();
    await vi.waitFor(() => expect(sdk.Location.permissionGranted).toBe(true));
    expect(query).toHaveBeenCalledWith({ name: 'geolocation' });
  });

  it('izin bilinmiyorken false', async () => {
    stubServer();
    const sdk = await start();
    expect(sdk.Location.permissionGranted).toBe(false);
  });
});

describe('Chat: getConfig, getConversation, setTyping, attachmentUrl', () => {
  it('mevcut sohbet uçlarını kullanır', async () => {
    const conversation = { id: 'conv_1', status: 'open', last_seq: 2, agent_last_read_seq: 0, visitor_last_read_seq: 0, unread_count: 2, bot_active: false, assignee_name: null, created_at: '2026-11-17T10:00:00Z' };
    const calls = stubServer((c) => {
      if (c.path === '/chat/config') return json(200, { enabled: true, online: true, title: 'Destek' });
      if (c.path === '/chat/conversation') return json(200, { conversation, unread_count: 2 });
      return undefined;
    });
    const sdk = await start();
    expect((await sdk.Chat.getConfig()).title).toBe('Destek');
    await sdk.Chat.getConfig();
    expect(calls.filter((c) => c.path === '/chat/config')).toHaveLength(1);
    await sdk.Chat.getConfig(true);
    expect(calls.filter((c) => c.path === '/chat/config')).toHaveLength(2);

    expect((await sdk.Chat.getConversation())?.id).toBe('conv_1');
    expect(sdk.Chat.unreadCount).toBe(2);

    sdk.Chat.setTyping(true);
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/chat/typing' && c.body.typing === true)).toBe(true));

    const url = new URL(sdk.Chat.attachmentUrl('att_1', true));
    expect(url.pathname).toBe('/sdk/v1/apps/app_1/chat/attachments/att_1');
    expect(url.searchParams.get('visitor_id')).toBeTruthy();
    expect(url.searchParams.get('download')).toBe('true');
  });
});

describe('InAppMessages.setRenderer', () => {
  const message = (display: Partial<InAppMessage['display']> = {}): InAppMessage => ({
    id: 'iam_1',
    priority: 0,
    triggers: [],
    remaining_impressions: 5,
    min_interval_seconds: 0,
    last_impression_at: null,
    end_at: null,
    stop_after_interaction: false,
    display: {
      layout: 'modal',
      background_color: null,
      text_color: null,
      dismissible: true,
      auto_dismiss_seconds: null,
      blocks: [
        { type: 'title', text: 'Merhaba' },
        { type: 'button', id: 'go', text: 'Git', action: { type: 'tags', tags: { ilgi: 'kampanya' } }, background_color: null, text_color: null },
        { type: 'carousel', id: 'c1', cards: [{ id: 'k1', title: 'Kart', body: null, image_url: null, image_alt: null, button: { id: 'kart_btn', text: 'Aç', action: { type: 'dismiss' } } }] },
      ],
      ...display,
    },
  });

  function manager() {
    const state = { inAppLocal: {} as Record<string, { lastAt: number; pending: number }>, inAppLastImpressionAt: null as number | null };
    const ops: QueuedOperation[] = [];
    const addTags = vi.fn();
    const defaultRender = vi.fn(() => ({ host: document.createElement('div'), close: vi.fn() }));
    const inApp = new InAppManager({
      api: () => ({}) as never,
      store: () => ({ get: () => state, update: (patch: Partial<typeof state>) => Object.assign(state, patch) }) as never,
      logger: new Logger('silent'),
      language: () => 'tr',
      subscriptionId: () => 'sub_1',
      ownershipHash: () => 'hash',
      enqueue: (op) => ops.push(op),
      addTags,
      requestPushPermission: async () => undefined,
      sendOutcome: vi.fn(),
      globalMinIntervalSeconds: () => 0,
      reportError: vi.fn(),
      render: defaultRender,
    });
    const events = () => ops.map((op) => (op.type === 'in_app_event' ? `${op.eventType}${op.buttonId ? `:${op.buttonId}` : ''}` : op.type));
    const show = (m: InAppMessage) => (inApp as unknown as { show: (msg: InAppMessage) => void }).show(m);
    return { inApp, events, addTags, defaultRender, show };
  }

  it('mesajı özel çizime verir; düğme tıklaması, aksiyon ve kapanış SDK\'da kalır', () => {
    const { inApp, events, addTags, defaultRender, show } = manager();
    const close = vi.fn();
    const shown: string[] = [];
    let clicked: (id: string) => void = () => undefined;
    const renderer: InAppRenderer = {
      show: (m, handle) => {
        shown.push(m.id);
        clicked = (id) => handle.buttonClicked(id);
        return { close };
      },
    };
    inApp.setRenderer(renderer);
    const lifecycle: string[] = [];
    inApp.lifecycleListeners.add({ didDisplay: () => lifecycle.push('didDisplay'), didDismiss: () => lifecycle.push('didDismiss') });
    show(message());
    expect(shown).toEqual(['iam_1']);
    expect(defaultRender).not.toHaveBeenCalled();
    expect(events()).toEqual(['impression']);

    clicked('bilinmeyen');
    expect(close).not.toHaveBeenCalled();
    clicked('go');
    expect(events()).toEqual(['impression', 'click:go']);
    expect(addTags).toHaveBeenCalledWith({ ilgi: 'kampanya' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(['didDisplay', 'didDismiss']);
    inApp.destroy();
  });

  it('kapatma bildirimi; kapanan mesajın tutamacı etkisizdir', () => {
    const { inApp, events, show } = manager();
    let handleRef: Parameters<InAppRenderer['show']>[1] | null = null;
    inApp.setRenderer({
      show: (_m, handle) => {
        handleRef = handle;
        return { close: () => undefined };
      },
    });
    show(message());
    handleRef!.dismissed();
    expect(events()).toEqual(['impression', 'dismiss']);
    // Kapanan mesajın tutamacı artık etkisizdir.
    handleRef!.buttonClicked('kart_btn');
    expect(events()).toEqual(['impression', 'dismiss']);
    inApp.destroy();
  });

  it('false dönerse mesaj gösterilmemiş sayılır; HTML mesaj ve null çizim varsayılana gider', () => {
    const skipped = manager();
    skipped.inApp.setRenderer({ show: () => false });
    skipped.show(message());
    expect(skipped.events()).toEqual([]);
    skipped.inApp.destroy();

    const html = manager();
    const show = vi.fn(() => ({ close: () => undefined }));
    html.inApp.setRenderer({ show });
    html.show(message({ content_type: 'html', html: '<p>x</p>' }));
    expect(show).not.toHaveBeenCalled();
    expect(html.defaultRender).toHaveBeenCalledTimes(1);
    html.inApp.destroy();

    const reset = manager();
    reset.inApp.setRenderer({ show });
    reset.inApp.setRenderer(null);
    reset.show(message());
    expect(show).not.toHaveBeenCalled();
    expect(reset.defaultRender).toHaveBeenCalledTimes(1);
    reset.inApp.destroy();
  });
});
