// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPlacement } from '../browser/placement-render.js';
import type { StateStore } from '../core/storage.js';
import type { InAppMessage } from '../core/types.js';
import { createSdk } from '../sdk.js';

const message = (over: Partial<InAppMessage['display']> = {}, id = 'iam_1'): InAppMessage =>
  ({
    id,
    priority: 0,
    triggers: [],
    trigger_groups: [],
    variant_id: 'var_1',
    remaining_impressions: 1000,
    min_interval_seconds: 0,
    stop_after_interaction: false,
    last_impression_at: null,
    end_at: null,
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
        { type: 'image', url: 'https://ornek.com/a.jpg', alt: 'Görsel' },
        { type: 'title', text: '<b>Başlık</b>' },
        { type: 'body', text: 'Gövde' },
        { type: 'button', id: 'b1', text: 'Git', action: { type: 'url', url: 'https://ornek.com/x' }, background_color: null, text_color: null },
      ],
      ...over,
    },
  }) as unknown as InAppMessage;

/** Faz 41 (ADR-0068): web yerleşimleri. */
describe('renderPlacement', () => {
  const noop = { language: 'tr', onButton: () => undefined, onDismiss: () => undefined };

  it('metni işaretleme olarak yorumlamaz, Shadow DOM içinde çizer', () => {
    const target = document.createElement('div');
    renderPlacement(message(), target, noop);
    const root = target.firstElementChild!.shadowRoot!;
    expect(root.querySelector('.hs-title')!.textContent).toBe('<b>Başlık</b>');
    expect(root.querySelector('.hs-title b')).toBeNull();
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://ornek.com/a.jpg');
    expect(root.querySelector('.hs-close')!.getAttribute('aria-label')).toBe('Kapat');
  });

  it('güvensiz görsel çizilmez, kapatılamayan mesajda düğme yoktur', () => {
    const target = document.createElement('div');
    renderPlacement(message({ dismissible: false, blocks: [{ type: 'image', url: 'javascript:alert(1)', alt: null }] } as never), target, noop);
    const root = target.firstElementChild!.shadowRoot!;
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.hs-close')).toBeNull();
  });

  it('düğme ve kapatma geri çağrılır, kaldırma öğeyi siler', () => {
    const target = document.createElement('div');
    const onButton = vi.fn();
    const onDismiss = vi.fn();
    const handle = renderPlacement(message(), target, { language: 'en', onButton, onDismiss });
    const root = target.firstElementChild!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.hs-button')!.click();
    expect(onButton).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
    root.querySelector<HTMLButtonElement>('.hs-close')!.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    handle.remove();
    expect(target.childElementCount).toBe(0);
  });
});

describe('Pushizo.Placements', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const TOKEN_HASH = 'a'.repeat(64);
  let requests: { path: string; search: URLSearchParams; body: Record<string, unknown> | undefined }[] = [];
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    requests = [];
    open = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        requests.push({ path: url.pathname, search: url.searchParams, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined });
        if (url.pathname.includes('/placements/')) return json(200, { data: [message()], language: 'tr' });
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
  const subscribe = (sdk: ReturnType<typeof createSdk>) => {
    (sdk as unknown as { store: StateStore }).store.update({ subscriptionId: 'sub_1', tokenHash: TOKEN_HASH });
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('abonelik yokken boş döner, istek gönderilmez', async () => {
    const sdk = await start();
    expect(await sdk.Placements.list('ana_sayfa')).toEqual([]);
    expect(requests.some((r) => r.path.includes('/placements/'))).toBe(false);
  });

  it('kanıtla ister, HTML istemez; geçersiz anahtar reddedilir', async () => {
    const sdk = await start();
    subscribe(sdk);
    expect(await sdk.Placements.list('ana_sayfa', { limit: 3 })).toHaveLength(1);
    const call = requests.find((r) => r.path.includes('/placements/'))!;
    expect(call.path).toContain('/placements/ana_sayfa');
    expect(call.search.get('subscription_id')).toBe('sub_1');
    expect(call.search.get('token_hash')).toBe(TOKEN_HASH);
    expect(call.search.get('limit')).toBe('3');
    // Boş `supports`: sunucu HTML ve carousel göndermez.
    expect(call.search.get('supports')).toBeNull();
    await expect(sdk.Placements.list('../kotu')).rejects.toThrow();
  });

  it('render çizer, gösterimi bir kez bildirir; tıklama bildirir ve adresi açar', async () => {
    const sdk = await start();
    subscribe(sdk);
    const target = document.createElement('div');
    const handle = await sdk.Placements.render('ana_sayfa', target);
    expect(handle.count).toBe(1);
    await flush();
    const events = () => requests.filter((r) => r.path.endsWith('/in-app/iam_1/events')).map((r) => r.body);
    expect(events()).toEqual([expect.objectContaining({ type: 'impression', subscription_id: 'sub_1', variant_id: 'var_1', token_hash: TOKEN_HASH })]);

    target.firstElementChild!.shadowRoot!.querySelector<HTMLButtonElement>('.hs-button')!.click();
    await flush();
    expect(events()[1]).toMatchObject({ type: 'click', button_id: 'b1' });
    expect(open).toHaveBeenCalledWith('https://ornek.com/x', '_blank', 'noopener,noreferrer');
  });

  it('kapatma bildirir ve içeriği kaldırır; yeniden çizim öncekini siler', async () => {
    const sdk = await start();
    subscribe(sdk);
    const target = document.createElement('div');
    await sdk.Placements.render('ana_sayfa', target);
    await sdk.Placements.render('ana_sayfa', target);
    expect(target.childElementCount).toBe(1);
    target.firstElementChild!.shadowRoot!.querySelector<HTMLButtonElement>('.hs-close')!.click();
    await flush();
    expect(target.childElementCount).toBe(0);
    expect(requests.some((r) => r.body?.type === 'dismiss')).toBe(true);
  });
});
