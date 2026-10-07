// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCustomLinks } from '../browser/custom-link.js';
import { DEFAULT_PROMPT_BACKOFF_DAYS, promptBackoffElapsed } from '../browser/prompts.js';
import { welcomeNotification, WELCOME_TAG } from '../browser/welcome.js';
import type { PersistedState } from '../core/types.js';
import { createSdk } from '../sdk.js';
import { parsePushPayload, pickClickTarget, resolveClickUrl, toNotificationOptions } from '../sw/payload.js';

const DAY = 86_400_000;

describe('istem geri çekilmesi (3/7/30 gün)', () => {
  const t0 = Date.UTC(2026, 9, 1);

  it('hiç reddedilmediyse gösterilebilir', () => {
    expect(promptBackoffElapsed(0, null, t0)).toBe(true);
  });

  it('ret sayısına göre 3, 7, sonra hep 30 gün beklenir', () => {
    expect(DEFAULT_PROMPT_BACKOFF_DAYS).toEqual([3, 7, 30]);
    expect(promptBackoffElapsed(1, t0, t0 + 3 * DAY - 1)).toBe(false);
    expect(promptBackoffElapsed(1, t0, t0 + 3 * DAY)).toBe(true);
    expect(promptBackoffElapsed(2, t0, t0 + 6 * DAY)).toBe(false);
    expect(promptBackoffElapsed(2, t0, t0 + 7 * DAY)).toBe(true);
    expect(promptBackoffElapsed(3, t0, t0 + 29 * DAY)).toBe(false);
    expect(promptBackoffElapsed(3, t0, t0 + 30 * DAY)).toBe(true);
    expect(promptBackoffElapsed(9, t0, t0 + 29 * DAY)).toBe(false);
  });

  it('özel takvim ve kapatma', () => {
    expect(promptBackoffElapsed(1, t0, t0 + DAY, [1])).toBe(true);
    expect(promptBackoffElapsed(5, t0, t0, [])).toBe(true);
    expect(promptBackoffElapsed(1, t0, t0, [0])).toBe(true);
  });
});

describe('bildirim tıklama davranışı', () => {
  const tabs = ['https://shop.example/', 'https://shop.example/sale?x=1', 'https://other.example/'];

  it('exact: yalnızca aynı URL odaklanır, yoksa yeni pencere', () => {
    expect(pickClickTarget(tabs, 'https://shop.example/sale?x=1', 'exact', 'navigate')).toEqual({ index: 1, navigate: false });
    expect(pickClickTarget(tabs, 'https://shop.example/new', null, null)).toBeNull();
  });

  it('origin + navigate: aynı origin sekmesi hedefe götürülür', () => {
    expect(pickClickTarget(tabs, 'https://shop.example/new', 'origin', 'navigate')).toEqual({ index: 0, navigate: true });
    expect(pickClickTarget(tabs, 'https://shop.example/new', 'origin', undefined)).toEqual({ index: 0, navigate: true });
  });

  it('origin + focus: sekme yalnızca öne getirilir', () => {
    expect(pickClickTarget(tabs, 'https://shop.example/new', 'origin', 'focus')).toEqual({ index: 0, navigate: false });
  });

  it('farklı origin veya geçersiz URL eşleşmez', () => {
    expect(pickClickTarget(tabs, 'https://third.example/', 'origin', 'navigate')).toBeNull();
    expect(pickClickTarget(tabs, 'myapp://x', 'origin', 'navigate')).toBeNull();
    expect(pickClickTarget(['not a url'], 'https://shop.example/', 'origin', 'navigate')).toBeNull();
  });
});

describe('web_buttons ve require_interaction', () => {
  it('düğme URL’leri ve requireInteraction korunur', () => {
    const p = parsePushPayload(
      JSON.stringify({
        title: 'Kampanya',
        body: 'Yüzde 20',
        url: 'https://shop.example/',
        badge: 'https://cdn.example/badge.png',
        requireInteraction: true,
        actions: [
          { action: 'buy', title: 'Satın al', url: 'https://shop.example/buy' },
          { action: 'later', title: 'Sonra' },
        ],
        hs: { dlv: 'dlv_1' },
      }),
    );
    const n = toNotificationOptions(p);
    expect(n.options.requireInteraction).toBe(true);
    expect(n.options.badge).toBe('https://cdn.example/badge.png');
    expect(n.options.actions).toEqual([
      { action: 'buy', title: 'Satın al', icon: undefined },
      { action: 'later', title: 'Sonra', icon: undefined },
    ]);
    expect(resolveClickUrl(n.options.data as never, 'buy')).toBe('https://shop.example/buy');
    expect(resolveClickUrl(n.options.data as never, 'later')).toBe('https://shop.example/');
  });
});

describe('karşılama bildirimi', () => {
  it('varsayılanlar: sayfa başlığı, dile göre metin, site kökü', () => {
    const w = welcomeNotification(undefined, 'tr-TR', 'Mağaza', 'https://shop.example')!;
    expect(w.title).toBe('Mağaza');
    expect(w.options.body).toBe('Abone olduğunuz için teşekkürler!');
    expect(w.options.tag).toBe(WELCOME_TAG);
    expect((w.options.data as { url: string }).url).toBe('https://shop.example/');
    expect(welcomeNotification({}, 'en', '', 'https://shop.example')!.title).toBe('shop.example');
  });

  it('özel metin/URL; güvensiz URL yok sayılır; disable', () => {
    const w = welcomeNotification({ title: 'Selam', message: 'Hoş geldin', url: 'https://shop.example/hi' }, 'en', 'X', 'https://shop.example')!;
    expect([w.title, w.options.body, (w.options.data as { url: string }).url]).toEqual(['Selam', 'Hoş geldin', 'https://shop.example/hi']);
    expect((welcomeNotification({ url: 'javascript:alert(1)' }, 'en', 'X', 'https://shop.example')!.options.data as { url: string }).url).toBe('https://shop.example/');
    expect(welcomeNotification({ disable: true }, 'en', 'X', 'https://shop.example')).toBeNull();
  });
});

describe('özel bağlantı istemi', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="herosignal-customlink-container"></div><div class="herosignal-customlink-container"></div>';
  });

  it('abone değilken açıklama ve abone ol düğmesi çizilir; tıklama işleyiciyi çağırır', async () => {
    const onClick = vi.fn(async () => undefined);
    const count = renderCustomLinks(
      { enabled: true, style: 'link', size: 'large', color: { text: '#ff0000', button: 'red;x' }, text: { explanation: '<b>x</b>' } },
      'tr',
      false,
      onClick,
    );
    expect(count).toBe(2);
    const container = document.querySelector('.herosignal-customlink-container')!;
    expect(container.querySelector('p')!.textContent).toBe('<b>x</b>');
    expect(container.querySelector('b')).toBeNull();
    const button = container.querySelector('button')!;
    expect(button.className).toBe('hs-cl-link hs-cl-large');
    expect(button.textContent).toBe('Bildirimlere abone ol');
    expect(button.style.color).toBe('#ff0000');
    expect(button.style.background).toBe('');
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('aboneyken unsubscribeEnabled kapalıysa gizlenir, açıksa çık düğmesi', () => {
    renderCustomLinks({ enabled: true }, 'en', true, async () => undefined);
    expect(document.querySelector('.herosignal-customlink-container button')).toBeNull();
    renderCustomLinks({ enabled: true, unsubscribeEnabled: true, text: { unsubscribe: 'Stop' } }, 'en', true, async () => undefined);
    const button = document.querySelector<HTMLButtonElement>('.herosignal-customlink-container button')!;
    expect(button.textContent).toBe('Stop');
    expect(button.className).toBe('hs-cl-button hs-cl-medium');
  });
});

describe('SDK: slidedown geri çekilmesi kalıcıdır', () => {
  const originalNotification = (window as unknown as { Notification?: unknown }).Notification;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    // Tarayıcı Web Push yüzeyi: izin henüz sorulmamış.
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'default') });
    (window as unknown as Record<string, unknown>).Notification = globalThis.Notification;
    (window as unknown as Record<string, unknown>).PushManager = function PushManager() {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const path = new URL(input).pathname;
        const body =
          path.endsWith('/config')
            ? { app_id: 'app_1', name: 'T', identity_verification_required: false, platforms: { web: true }, web: { vapid_public_key: null, allowed_origins: [] }, session: { timeout_seconds: 30 } }
            : { ok: true };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    (window as unknown as Record<string, unknown>).Notification = originalNotification;
    delete (window as unknown as Record<string, unknown>).PushManager;
  });

  const stored = () => JSON.parse(localStorage.getItem('hs:app_1') ?? '{}') as PersistedState;

  /** İstemi açar; slidedown görünürse "Şimdi değil" ile kapatır. Görünüp görünmediğini döndürür. */
  async function promptAndDismiss(hs: ReturnType<typeof createSdk>, force = false): Promise<boolean> {
    let done = false;
    const pending = hs.Slidedown.promptPush({ force }).then(() => {
      done = true;
    });
    for (let i = 0; i < 100 && !done && !document.querySelector('.hs-slidedown'); i++)
      await new Promise((r) => setTimeout(r, 1));
    const cancel = document.querySelector<HTMLButtonElement>('.hs-slidedown .hs-cancel');
    cancel?.click();
    await pending;
    return cancel !== null;
  }

  it('reddedilen slidedown 3 gün, sonra 7 gün gösterilmez; force takvimi atlar', async () => {
    if (!('serviceWorker' in navigator)) Object.defineProperty(navigator, 'serviceWorker', { value: new EventTarget(), configurable: true });
    const hs = createSdk();
    await hs.init({ appId: 'app_1', apiUrl: 'https://api.test', logLevel: 'silent', slidedown: { enabled: false } });

    expect(await promptAndDismiss(hs)).toBe(true);
    expect(stored().promptDismissCount).toBe(1);

    vi.setSystemTime(Date.now() + 2 * DAY);
    expect(await promptAndDismiss(hs)).toBe(false);
    vi.setSystemTime(Date.now() + 1 * DAY);
    expect(await promptAndDismiss(hs)).toBe(true);
    expect(stored().promptDismissCount).toBe(2);

    vi.setSystemTime(Date.now() + 6 * DAY);
    expect(await promptAndDismiss(hs)).toBe(false);
    // force: takvim atlanır (izin hâlâ sorulmamış).
    expect(await promptAndDismiss(hs, true)).toBe(true);
    expect(stored().promptDismissCount).toBe(3);
  });
});
