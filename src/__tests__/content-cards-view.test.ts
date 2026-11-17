// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadContentCardsWidget, type ContentCardsMountOptions, type ContentCardsSource } from '../core/content-cards.js';
import type { ContentCard } from '../core/types.js';
import { cardParts, mountContentCards } from '../content-cards/widget.js';
import { createSdk } from '../sdk.js';

/** ADR-0082: Web hazır içerik kartı görünümü (ayrı tembel paket). */

declare const __dirname: string;

const card = (n: number, patch: Partial<ContentCard> = {}): ContentCard => ({
  id: `card_${n}`,
  messageId: `msg_${n}`,
  type: 'classic',
  title: `Kart ${n}`,
  body: `Gövde ${n}`,
  url: `https://shop.example.com/k/${n}`,
  imageUrl: null,
  buttonText: null,
  data: {},
  pinned: false,
  priority: 0,
  viewed: false,
  clicked: false,
  expiresAt: null,
  createdAt: '2026-11-17T10:00:00Z',
  ...patch,
});

function fakeSource(cards: ContentCard[] | (() => Promise<ContentCard[]>)) {
  const events: string[] = [];
  const source: ContentCardsSource = {
    list: vi.fn(async () => {
      const data = typeof cards === 'function' ? await cards() : cards;
      return { cards: data, unviewedCount: data.filter((c) => !c.viewed).length };
    }),
    logImpression: vi.fn(async (id) => (events.push(`impression:${id}`), card(1))),
    logClick: vi.fn(async (id) => (events.push(`click:${id}`), card(1))),
    dismiss: vi.fn(async (id) => (events.push(`dismiss:${id}`), card(1))),
  };
  return { source, events };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount(source: ContentCardsSource, options: Partial<ContentCardsMountOptions> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const handle = mountContentCards(source, target, { language: 'tr', dir: 'ltr', ...options });
  await tick();
  const root = target.querySelector<HTMLElement>('[data-pushizo-cards]')!.shadowRoot!;
  return { handle, target, root, items: () => Array.from(root.querySelectorAll<HTMLElement>('li')), status: () => root.querySelector<HTMLElement>('.status')! };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).PushizoContentCards;
  delete (globalThis as Record<string, unknown>).__hsCardsLoad;
});

describe('cardParts (mobil SDK\'larla aynı yerleşim kuralı)', () => {
  it('türe göre parçalar', () => {
    expect(cardParts(card(1))).toEqual(['text']);
    expect(cardParts(card(1, { buttonText: 'Aç' }))).toEqual(['text', 'button']);
    expect(cardParts(card(1, { type: 'captioned_image', imageUrl: 'https://cdn.example.com/a.png' }))).toEqual(['image', 'text']);
    expect(cardParts(card(1, { type: 'captioned_image', imageUrl: 'https://cdn.example.com/a.png', title: null, body: ' ' }))).toEqual(['image']);
    expect(cardParts(card(1, { type: 'image_only', imageUrl: 'https://cdn.example.com/a.png', buttonText: 'Aç' }))).toEqual(['image']);
    // Görseli olmayan görsel kartı metne düşer.
    expect(cardParts(card(1, { type: 'image_only', imageUrl: null }))).toEqual(['text']);
  });
});

describe('mountContentCards', () => {
  it('kartları Shadow DOM içinde textContent ile çizer; erişilebilir adlar ve sabitlenmiş etiketi', async () => {
    const { source } = fakeSource([card(1, { pinned: true, title: '<b>Kampanya</b>' }), card(2, { buttonText: 'İncele' })]);
    const onFeedLoaded = vi.fn();
    const { root, items, status, target } = await mount(source, { onFeedLoaded, dir: 'rtl', language: 'ar' });
    expect(target.textContent).toBe('');
    expect(root.querySelector('section')!.getAttribute('aria-label')).toBe('Cards');
    expect(target.querySelector('[data-pushizo-cards]')!.getAttribute('dir')).toBe('rtl');
    expect(status().hidden).toBe(true);
    expect(items()).toHaveLength(2);
    expect(items()[0]!.querySelector('h3')!.textContent).toBe('<b>Kampanya</b>');
    expect(items()[0]!.querySelector('b')).toBeNull();
    expect(items()[0]!.querySelector('.pin')!.textContent).toBe('Pinned');
    // Düğmesiz bağlantılı kartta içerik bağlantıdır; düğmeli kartta yalnız düğme.
    expect(items()[0]!.querySelector('a.link')!.getAttribute('href')).toBe('https://shop.example.com/k/1');
    expect(items()[1]!.querySelector('a.link')).toBeNull();
    expect(items()[1]!.querySelector('a.btn')!.textContent).toBe('İncele');
    expect(items()[1]!.querySelector('.close')!.getAttribute('aria-label')).toBe('Dismiss card: Kart 2');
    expect(onFeedLoaded).toHaveBeenCalledWith(expect.objectContaining({ unviewedCount: 2 }));
    expect(source.list).toHaveBeenCalledWith(50);
  });

  it('tr/en dışı dilde aktarılan metinler, özel renk ve tema kullanılır', async () => {
    const { source } = fakeSource([]);
    const { root, status } = await mount(source, { language: 'de', strings: { empty: 'Noch keine Karten', label: 'Karten' }, color: '#ff0000', theme: 'dark', limit: 5 });
    expect(status().textContent).toContain('Noch keine Karten');
    expect(root.querySelector('section')!.getAttribute('aria-label')).toBe('Karten');
    expect(root.querySelector('style')!.textContent).toContain('--hs-accent:#ff0000');
    expect(root.querySelector('style')!.textContent).not.toContain('prefers-color-scheme');
    expect(source.list).toHaveBeenCalledWith(5);
  });

  it('güvensiz bağlantı ve görsel adresi çizilmez', async () => {
    const { source } = fakeSource([card(1, { url: 'javascript:alert(1)', type: 'captioned_image', imageUrl: 'data:text/html,x', buttonText: 'Aç' })]);
    const { items } = await mount(source);
    expect(items()[0]!.querySelector('a')).toBeNull();
    expect(items()[0]!.querySelector('img')).toBeNull();
    expect(items()[0]!.querySelector('h3')!.textContent).toBe('Kart 1');
  });

  it('yalnız görsel kart: bağlantı ve görsel erişilebilir ad taşır', async () => {
    const { source } = fakeSource([card(1, { type: 'image_only', imageUrl: 'https://cdn.example.com/a.png', body: null })]);
    const { items } = await mount(source);
    expect(items()[0]!.querySelector('a.link')!.getAttribute('aria-label')).toBe('Kart 1');
    expect(items()[0]!.querySelector('img')!.getAttribute('alt')).toBe('Kart 1');
    expect(items()[0]!.querySelector('h3')).toBeNull();
  });

  it('IntersectionObserver yoksa gösterim hemen ve kart başına bir kez kaydedilir; görülmüş kart atlanır', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { source, events } = fakeSource([card(1), card(2, { viewed: true })]);
    const { handle } = await mount(source);
    expect(events).toEqual(['impression:card_1']);
    await handle.refresh();
    expect(events).toEqual(['impression:card_1']);
  });

  it('en az yarısı görünen kart için gösterim kaydedilir', async () => {
    let fire: (entries: unknown[]) => void = () => undefined;
    const observed: Element[] = [];
    class FakeObserver {
      constructor(cb: (entries: unknown[]) => void, readonly init: { threshold: number }) {
        fire = cb;
      }
      observe(node: Element) {
        observed.push(node);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { source, events } = fakeSource([card(1), card(2)]);
    await mount(source);
    expect(observed).toHaveLength(2);
    expect(events).toEqual([]);
    fire([
      { target: observed[0], isIntersecting: true, intersectionRatio: 0.4 },
      { target: observed[1], isIntersecting: true, intersectionRatio: 0.6 },
    ]);
    fire([{ target: observed[1], isIntersecting: true, intersectionRatio: 1 }]);
    expect(events).toEqual(['impression:card_2']);
  });

  it('tıklama kaydedilir; onCardClick true dönerse varsayılan gezinme engellenir', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { source, events } = fakeSource([card(1, { viewed: true }), card(2, { viewed: true })]);
    const onCardClick = vi.fn((c: ContentCard) => c.id === 'card_1');
    const { items } = await mount(source, { onCardClick, newTab: true });
    const links = items().map((i) => i.querySelector<HTMLAnchorElement>('a.link')!);
    expect(links[0]!.target).toBe('_blank');
    expect(links[0]!.rel).toBe('noopener noreferrer');
    const first = new MouseEvent('click', { bubbles: true, cancelable: true });
    links[0]!.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const second = new MouseEvent('click', { bubbles: true, cancelable: true });
    links[1]!.addEventListener('click', (e) => e.preventDefault(), { once: true });
    links[1]!.dispatchEvent(second);
    expect(events).toEqual(['click:card_1', 'click:card_2']);
    expect(onCardClick).toHaveBeenCalledTimes(2);
  });

  it('kapatma: kart kalkar, odak komşu karta geçer, son kart kapanınca boş durum', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { source, events } = fakeSource([card(1, { viewed: true }), card(2, { viewed: true })]);
    const { items, status, root } = await mount(source);
    items()[0]!.querySelector<HTMLButtonElement>('.close')!.click();
    expect(items()).toHaveLength(1);
    expect(root.activeElement).toBe(items()[0]!.querySelector('.close'));
    items()[0]!.querySelector<HTMLButtonElement>('.close')!.click();
    expect(items()).toHaveLength(0);
    expect(status().hidden).toBe(false);
    expect(status().textContent).toContain('Henüz kart yok');
    expect(root.activeElement).toBe(root.querySelector('section'));
    expect(events).toEqual(['dismiss:card_1', 'dismiss:card_2']);
  });

  it('yükleniyor → hata (yeniden dene) → içerik', async () => {
    let fail = true;
    const { source } = fakeSource(async () => {
      if (fail) throw new Error('ağ');
      return [card(1)];
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountContentCards(source, target, { language: 'tr', dir: 'ltr' });
    const root = target.querySelector<HTMLElement>('[data-pushizo-cards]')!.shadowRoot!;
    const status = root.querySelector<HTMLElement>('.status')!;
    const retry = root.querySelector<HTMLButtonElement>('.retry')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('Yükleniyor…');
    expect(root.querySelector('section')!.getAttribute('aria-busy')).toBe('true');
    expect(retry.hidden).toBe(true);
    await tick();
    expect(status.textContent).toContain('Kartlar yüklenemedi.');
    expect(retry.hidden).toBe(false);
    expect(retry.textContent).toBe('Tekrar dene');
    fail = false;
    retry.click();
    await tick();
    expect(status.hidden).toBe(true);
    expect(root.querySelectorAll('li')).toHaveLength(1);
    expect(root.querySelector('section')!.getAttribute('aria-busy')).toBe('false');
  });

  it('aynı hedefe yeniden kurulum öncekini kaldırır; destroy görünümü siler', async () => {
    const { source } = fakeSource([card(1)]);
    const first = await mount(source);
    const again = mountContentCards(source, first.target, { language: 'tr', dir: 'ltr' });
    expect(first.target.querySelectorAll('[data-pushizo-cards]')).toHaveLength(1);
    again.destroy();
    expect(first.target.querySelector('[data-pushizo-cards]')).toBeNull();
    await again.refresh();
  });
});

describe('Pushizo.ContentCards.render', () => {
  it('paketleyici mount\'u ile dil, yön ve veri kaynağını aktarır; hedef yoksa hata', async () => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ app_id: 'app_1', web: { vapid_public_key: null, allowed_origins: [] }, session: { timeout_seconds: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const sdk = createSdk();
    await sdk.init({ appId: 'app_1', apiUrl: 'https://api.example.com', webCampaigns: false, webPersonalization: false, language: 'ar' });
    const target = document.createElement('div');
    target.id = 'kartlar';
    document.body.appendChild(target);
    const handle = { refresh: async () => undefined, destroy: () => undefined };
    const mountFn = vi.fn(() => handle);
    expect(await sdk.ContentCards.render('#kartlar', { mount: mountFn, limit: 10 })).toBe(handle);
    const [source, element, options] = mountFn.mock.calls[0] as unknown as [ContentCardsSource, Element, ContentCardsMountOptions];
    expect(source).toBe(sdk.ContentCards);
    expect(element).toBe(target);
    expect(options).toMatchObject({ language: 'ar', dir: 'rtl', limit: 10 });
    await expect(sdk.ContentCards.render('#yok', { mount: mountFn })).rejects.toThrow(/hedef/);
  });

  it('ana paket kart görünümünü içermez (ayrı paket) ve boyut bütçesi tanımlıdır', async () => {
    const fs = await vi.importActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('node:fs');
    const path = await vi.importActual<{ resolve(...parts: string[]): string }>('node:path');
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    expect(read('../sdk.ts')).not.toMatch(/content-cards\/widget/);
    expect(read('../core/content-cards.ts')).not.toMatch(/from '\.\.\/content-cards/);
    const budget = JSON.parse(read('../../size-budget.json')) as { files: Record<string, number> };
    expect(budget.files['dist/PushizoContentCards.js']).toBeLessThanOrEqual(4 * 1024);
    expect(read('../../build.mjs')).toContain("outfile: 'dist/PushizoContentCards.js'");
  });

  it('loadContentCardsWidget betiği bir kez yükler; hata sonrası yeniden denenebilir', async () => {
    const appended: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation(((node: HTMLScriptElement) => (appended.push(node), node)) as never);
    const failing = loadContentCardsWidget('https://api.test/sdk-web/PushizoContentCards.js', 'n1');
    expect(appended[0]!.nonce).toBe('n1');
    appended[0]!.onerror!(new Event('error'));
    await expect(failing).rejects.toThrow(/yüklenemedi/);
    const a = loadContentCardsWidget('https://api.test/sdk-web/PushizoContentCards.js');
    const b = loadContentCardsWidget('https://api.test/sdk-web/PushizoContentCards.js');
    expect(a).toBe(b);
    expect(appended).toHaveLength(2);
    const mod = { mount: vi.fn() };
    (globalThis as Record<string, unknown>).PushizoContentCards = mod;
    appended[1]!.onload!(new Event('load'));
    expect(await a).toBe(mod);
    vi.restoreAllMocks();
  });
});
