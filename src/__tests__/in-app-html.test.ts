// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InAppManager, type InAppHost } from '../browser/in-app.js';
import { renderInAppMessage, type InAppRenderOptions } from '../browser/in-app-render.js';
import { HTML_BRIDGE_MARK, HTML_IN_APP_CSP } from '../core/html-bridge.js';
import { Logger } from '../core/logger.js';
import type { InAppMessage } from '../core/types.js';

function htmlMessage(display: Partial<InAppMessage['display']> = {}): InAppMessage {
  return {
    id: 'iam_html',
    priority: 0,
    triggers: [{ kind: 'session_start' }],
    remaining_impressions: 1,
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
      content_type: 'html',
      html: '<h1>Merhaba</h1><button data-hs-close>Kapat</button>',
      html_height: 300,
      blocks: [],
      ...display,
    },
  };
}

function carouselMessage(): InAppMessage {
  return {
    ...htmlMessage(),
    id: 'iam_carousel',
    display: {
      layout: 'modal',
      background_color: null,
      text_color: null,
      dismissible: true,
      auto_dismiss_seconds: null,
      content_type: 'blocks',
      html: null,
      html_height: null,
      blocks: [
        { type: 'title', text: 'Neler var?' },
        {
          type: 'carousel',
          id: 'steps',
          cards: [
            { id: 'c1', title: 'Takip et', body: 'Konuları seç', image_url: 'https://cdn.example.com/1.png', image_alt: 'Takip görseli', button: null },
            { id: 'c2', title: '<b>Kaydet</b>', body: null, image_url: 'javascript:alert(1)', image_alt: null, button: { id: 'enable', text: 'Aç', action: { type: 'push_prompt' } } },
          ],
        },
      ],
    },
  };
}

const handles: { close: () => void }[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  document.body.innerHTML = '';
});

function render(message: InAppMessage, extra: Partial<InAppRenderOptions> = {}) {
  const options: InAppRenderOptions = { language: 'tr', onButton: vi.fn(), onDismiss: vi.fn(), onAutoDismiss: vi.fn(), onBridge: vi.fn(), ...extra };
  const handle = renderInAppMessage(message, options);
  handles.push(handle);
  const iframe = handle.host.shadowRoot!.querySelector('iframe');
  return { handle, options, iframe, root: handle.host.shadowRoot! };
}

/** iframe penceresinden geliyormuş gibi köprü mesajı. */
function post(source: unknown, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: source as Window, origin: 'null' }));
}

const bridge = (nonce: string, extra: Record<string, unknown>) => ({ hs: HTML_BRIDGE_MARK, v: 1, nonce, ...extra });

function nonceOf(iframe: HTMLIFrameElement): string {
  return /var N="([^"]+)"/.exec(iframe.srcdoc)![1]!;
}

describe('HTML in-app: sandbox iframe', () => {
  it('sandbox yalnızca allow-scripts; CSP meta ilk sırada; erişilebilir başlık ve yükseklik', () => {
    const { iframe } = render(htmlMessage());
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe!.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe!.title).toBe('Mesaj');
    expect(iframe!.style.height).toBe('300px');
    const doc = iframe!.srcdoc;
    expect(doc.indexOf(`content="${HTML_IN_APP_CSP}"`)).toBeGreaterThan(0);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<h1>Merhaba</h1>'));
    expect(nonceOf(iframe!)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('köprü: yalnızca iframe penceresinden ve doğru nonce ile; şema doğrulanır', () => {
    const { iframe, options } = render(htmlMessage());
    const nonce = nonceOf(iframe!);
    const win = iframe!.contentWindow;
    expect(win).toBeTruthy();
    // Yanlış kaynak (üst pencere / başka çerçeve) ve yanlış nonce yok sayılır.
    post(window, bridge(nonce, { type: 'click', action_id: 'buy' }));
    post(null, bridge(nonce, { type: 'click', action_id: 'buy' }));
    post(win, bridge('baska-nonce-0000', { type: 'click', action_id: 'buy' }));
    post(win, bridge(nonce, { type: 'click', action_id: '<x>' }));
    expect(options.onBridge).not.toHaveBeenCalled();
    post(win, bridge(nonce, { type: 'click', action_id: 'buy', url: 'javascript:alert(1)' }));
    expect(options.onBridge).toHaveBeenLastCalledWith({ type: 'click', actionId: 'buy' });
    post(win, bridge(nonce, { type: 'add_tag', key: 'plan', value: 'gold' }));
    expect(options.onBridge).toHaveBeenLastCalledWith({ type: 'add_tag', key: 'plan', value: 'gold' });
    post(win, bridge(nonce, { type: 'track_event', name: 'nps', props: { score: 9 } }));
    expect(options.onBridge).toHaveBeenLastCalledWith({ type: 'track_event', name: 'nps', props: { score: 9 } });
    post(win, bridge(nonce, { type: 'resize', height: 180 }));
    expect(iframe!.style.height).toBe('180px');
    expect(options.onDismiss).not.toHaveBeenCalled();
    post(win, bridge(nonce, { type: 'close' }));
    expect(options.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('iframe kendi içinde gezinirse (ikinci load) mesaj kapatılır; kapanınca dinleyiciler temizlenir', () => {
    const { iframe, options, handle } = render(htmlMessage());
    iframe!.dispatchEvent(new Event('load'));
    expect(options.onDismiss).not.toHaveBeenCalled();
    iframe!.dispatchEvent(new Event('load'));
    expect(options.onDismiss).toHaveBeenCalledTimes(1);
    const nonce = nonceOf(iframe!);
    const win = iframe!.contentWindow;
    handle.close();
    post(win, bridge(nonce, { type: 'click', action_id: 'late' }));
    expect(options.onBridge).not.toHaveBeenCalled();
  });

  it('tam ekranda yükseklik sabitlenmez; banner varsayılan yükseklik alır', () => {
    expect(render(htmlMessage({ layout: 'fullscreen' })).iframe!.style.height).toBe('');
    expect(render(htmlMessage({ layout: 'banner_top', html_height: null })).iframe!.style.height).toBe('120px');
  });
});

describe('carousel bloğu', () => {
  it('kartlar erişilebilir etiketlerle; metinler textContent; güvensiz görsel atlanır; kart düğmesi onButton', () => {
    const { root, options } = render(carouselMessage());
    const region = root.querySelector('.hs-carousel')!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-roledescription')).toBe('carousel');
    expect(region.getAttribute('aria-label')).toBe('Kartlar');
    const slides = [...root.querySelectorAll('.hs-slide')];
    expect(slides.map((s) => s.getAttribute('aria-label'))).toEqual(['Kart 1/2', 'Kart 2/2']);
    expect(slides[0]!.querySelector('img')!.getAttribute('alt')).toBe('Takip görseli');
    expect(slides[1]!.querySelector('img')).toBeNull();
    expect(slides[1]!.querySelector('h3')!.innerHTML).toBe('&lt;b&gt;Kaydet&lt;/b&gt;');
    const nav = [...root.querySelectorAll('.hs-nav')];
    expect(nav.map((b) => b.getAttribute('aria-label'))).toEqual(['Önceki kart', 'Sonraki kart']);
    (slides[1]!.querySelector('button') as HTMLButtonElement).click();
    expect(options.onButton).toHaveBeenCalledWith({ type: 'button', id: 'enable', text: 'Aç', action: { type: 'push_prompt' }, background_color: null, text_color: null });
  });
});

describe('InAppManager köprü eylemleri', () => {
  function manager() {
    let captured: InAppRenderOptions | null = null;
    const state = { inAppLocal: {} as Record<string, { lastAt: number; pending: number; interacted?: boolean }>, inAppLastImpressionAt: null as number | null };
    const host: InAppHost = {
      api: () => ({}) as never,
      store: () => ({ get: () => state, update: (patch: Partial<typeof state>) => Object.assign(state, patch) }) as never,
      logger: new Logger('silent'),
      language: () => 'tr',
      subscriptionId: () => 'sub_1',
      ownershipHash: () => null,
      enqueue: vi.fn(),
      addTags: vi.fn(),
      requestPushPermission: vi.fn(async () => undefined),
      sendOutcome: vi.fn(),
      sendEvent: vi.fn(),
      globalMinIntervalSeconds: () => 0,
      reportError: vi.fn(),
      openUrl: vi.fn(),
      navigate: vi.fn(),
      render: (message, options) => {
        captured = options;
        return { host: document.createElement('div'), close: vi.fn() };
      },
    };
    const m = new InAppManager(host);
    return { m, host, options: () => captured! };
  }

  it('click: tıklama olayı (button_id = eylem kimliği), dinleyici, kapanış ve güvenli URL açılışı; tag ve olay kapatmaz', () => {
    const { m, host, options } = manager();
    const clicks: unknown[] = [];
    m.clickListeners.add((e) => clicks.push(e));
    (m as unknown as { show: (msg: InAppMessage) => void }).show(htmlMessage());
    options().onBridge!({ type: 'add_tag', key: 'nps', value: '9' });
    expect(host.addTags).toHaveBeenCalledWith({ nps: '9' });
    options().onBridge!({ type: 'track_event', name: 'nps_score', props: { score: 9 } });
    expect(host.sendEvent).toHaveBeenCalledWith('nps_score', { score: 9 });
    options().onBridge!({ type: 'click', actionId: 'shop', url: 'https://shop.example.com/sale' });
    expect(host.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'in_app_event', eventType: 'click', buttonId: 'shop', messageId: 'iam_html' }));
    expect(clicks).toEqual([{ message: { id: 'iam_html' }, result: { actionId: 'shop', url: 'https://shop.example.com/sale' } }]);
    expect(host.openUrl).toHaveBeenCalledWith('https://shop.example.com/sale');
    // Mesaj kapandıktan sonra gelen eylemler yok sayılır.
    options().onBridge!({ type: 'add_tag', key: 'late', value: 'x' });
    expect(host.addTags).toHaveBeenCalledTimes(1);
  });

  it('uygulama şemalı URL deeplink olarak açılır', () => {
    const { m, host, options } = manager();
    (m as unknown as { show: (msg: InAppMessage) => void }).show(htmlMessage());
    options().onBridge!({ type: 'click', actionId: 'cart', url: 'myapp://cart' });
    expect(host.navigate).toHaveBeenCalledWith('myapp://cart');
    expect(host.openUrl).not.toHaveBeenCalled();
  });
});
