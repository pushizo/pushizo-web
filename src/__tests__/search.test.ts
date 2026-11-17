// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkApi } from '../core/api.js';
import { Logger } from '../core/logger.js';
import { SearchClient, loadSearchWidget, type SearchResponse, type SearchWidgetHandle, type SearchWidgetMountOptions } from '../core/search.js';
import { mountSearchWidget } from '../search-widget/widget.js';

/** ADR-0093: Web SDK site içi arama istemcisi ve arama penceresi. */

declare const __dirname: string;

interface Call {
  url: string;
  body: Record<string, unknown>;
  keepalive: boolean;
}

const result = (n: number, patch: Partial<SearchResponse['results'][number]> = {}) => ({
  id: `sdoc_${n}`,
  url: `https://shop.example.com/sayfa-${n}`,
  title: `Sayfa ${n}`,
  heading: `Bölüm ${n}`,
  snippet: `Kargo ücreti ${n}`,
  snippet_html: `<mark>Kargo</mark> ücreti ${n} &lt;script&gt;alert(1)&lt;/script&gt;`,
  ...patch,
});

/** Sahte sunucu: arama ucunu bellekte yanıtlar ve çağrıları kaydeder. */
function fakeServer(respond: (body: Record<string, unknown>) => Partial<SearchResponse> | number = () => ({})) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    calls.push({ url, body, keepalive: init?.keepalive === true });
    if (url.endsWith('/search/events')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const out = respond(body);
    if (typeof out === 'number') return new Response(JSON.stringify({ error: { code: 'HS_FORBIDDEN', message: 'kapalı' } }), { status: out });
    const response: SearchResponse = { query_id: 'ssq_1', mode: 'search', results: [result(1), result(2), result(3)], answer: null, answer_status: null, answers_available: false, ...out };
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
  const api = new SdkApi({ baseUrl: 'https://api.test/', appId: 'app_1', fetch: fetchImpl, logger: new Logger('silent'), maxRetries: 0 });
  const client = new SearchClient({ api: () => api, language: () => 'tr', fetch: fetchImpl });
  return { calls, client, searches: () => calls.filter((c) => c.url.endsWith('/search')) };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true, ...init }));

function mount(server: ReturnType<typeof fakeServer>, options: Partial<SearchWidgetMountOptions> = {}) {
  const handle = mountSearchWidget(server.client, { language: 'tr', dir: 'ltr', ...options });
  const host = document.querySelector('[data-pushizo-search]') as HTMLElement;
  const root = host.shadowRoot!;
  const q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  const input = q<HTMLInputElement>('input');
  const type = async (value: string, wait = 300) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(wait);
  };
  return { handle, host, root, q, input, type, items: () => Array.from(root.querySelectorAll<HTMLElement>('.item')) };
}

describe('SearchClient (başsız kullanım)', () => {
  it('sorgu: mod, dil ve sınır gövdede; kimlik gönderilmez', async () => {
    const server = fakeServer();
    const res = await server.client.query('  kargo ücreti ', { mode: 'answer', limit: 5 });
    expect(res.results).toHaveLength(3);
    expect(server.calls[0]).toMatchObject({ url: 'https://api.test/sdk/v1/apps/app_1/search', body: { query: 'kargo ücreti', mode: 'answer', language: 'tr', limit: 5 } });
    await server.client.query('iade');
    expect(server.calls[1]!.body).toEqual({ query: 'iade', mode: 'search', language: 'tr' });
    expect(Object.keys(server.calls[1]!.body)).not.toContain('subscription_id');
  });

  it('tıklama keepalive ile bildirilir; hata ve boş sorgu kimliği yutulur', async () => {
    const server = fakeServer();
    await server.client.trackClick('ssq_1', 'https://shop.example.com/kargo', 2);
    expect(server.calls[0]).toMatchObject({ url: 'https://api.test/sdk/v1/apps/app_1/search/events', keepalive: true, body: { query_id: 'ssq_1', type: 'click', url: 'https://shop.example.com/kargo', position: 2 } });
    await server.client.trackClick('', 'https://shop.example.com/kargo');
    expect(server.calls).toHaveLength(1);
    const failing = new SearchClient({ api: () => new SdkApi({ baseUrl: 'https://api.test', appId: 'app_1', logger: new Logger('silent') }), language: () => 'tr', fetch: () => Promise.reject(new Error('ağ')) });
    await expect(failing.trackClick('ssq_1', 'https://shop.example.com/')).resolves.toBeUndefined();
    await expect(new SearchClient({ api: () => null, language: () => 'tr' }).trackClick('ssq_1', 'https://x.test/')).resolves.toBeUndefined();
    expect(() => new SearchClient({ api: () => null, language: () => 'tr' }).query('kargo')).toThrow(/init/);
  });
});

describe('arama penceresi', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('erişilebilir yapı: dialog, combobox, listbox, canlı durum; kapalı başlar ve dil/yön alır', () => {
    const ui = mount(fakeServer(), { language: 'ar', dir: 'rtl', strings: { title: 'ابحث', placeholder: 'عمّ تبحث؟' } });
    expect(ui.host.getAttribute('dir')).toBe('rtl');
    expect(ui.host.getAttribute('lang')).toBe('ar');
    expect(ui.q<HTMLElement>('.overlay').hidden).toBe(true);
    const dialog = ui.q<HTMLElement>('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // tr/en dışındaki dilde aktarılan metinler kullanılır, eksik anahtar İngilizceye düşer.
    expect(dialog.getAttribute('aria-label')).toBe('ابحث');
    expect(ui.input.placeholder).toBe('عمّ تبحث؟');
    expect(ui.q<HTMLElement>('.icon').getAttribute('aria-label')).toBe('Close');
    expect(ui.input.getAttribute('role')).toBe('combobox');
    expect(ui.input.getAttribute('aria-controls')).toBe(ui.q('[role="listbox"]').id);
    expect(ui.q('[role="status"]').getAttribute('aria-live')).toBe('polite');
    expect(ui.handle.isOpen()).toBe(false);
  });

  it('yazarken gecikmeli arama, sonuçlar güvenli çizilir, eski yanıt atılır', async () => {
    const server = fakeServer();
    const ui = mount(server);
    ui.handle.open();
    expect(ui.handle.isOpen()).toBe(true);
    expect(ui.root.activeElement).toBe(ui.input);
    await ui.type('k');
    expect(server.searches()).toHaveLength(0);
    expect(ui.q('[role="status"]').textContent).toBe('Aramak için en az 2 karakter yazın.');
    await ui.type('ka', 50);
    await ui.type('kargo');
    // Ara tuş vuruşları tek isteğe iner.
    expect(server.searches()).toHaveLength(1);
    expect(server.searches()[0]!.body).toMatchObject({ query: 'kargo', mode: 'search' });
    const items = ui.items();
    expect(items).toHaveLength(3);
    expect(ui.q('[role="status"]').textContent).toBe('3 sonuç');
    expect(ui.input.getAttribute('aria-expanded')).toBe('true');
    expect(items[0]!.querySelector('.title')!.textContent).toBe('Sayfa 1 › Bölüm 1');
    // Kesit: yalnız <mark> öğe olur, kalan her şey metin (betik enjekte edilemez).
    const snippet = items[0]!.querySelector('.snippet')!;
    expect(snippet.querySelectorAll('mark')).toHaveLength(1);
    expect(snippet.querySelector('script')).toBeNull();
    expect(snippet.textContent).toBe('Kargo ücreti 1 <script>alert(1)</script>');
    expect(items[0]!.querySelector('a')!.getAttribute('href')).toBe('https://shop.example.com/sayfa-1');
  });

  it('tehlikeli adresli sonuç çizilmez', async () => {
    const server = fakeServer(() => ({ results: [result(1, { url: 'javascript:alert(1)' }), result(2)] }));
    const ui = mount(server);
    ui.handle.open();
    await ui.type('kargo');
    expect(ui.items().map((i) => i.querySelector('a')!.getAttribute('href'))).toEqual(['https://shop.example.com/sayfa-2']);
  });

  it('klavye: ok tuşlarıyla gezinme, Enter ile açma ve tıklama bildirimi, Esc ile kapanma ve odağın geri dönmesi', async () => {
    const server = fakeServer();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const selected: string[] = [];
    const ui = mount(server, { onSelect: (r) => (selected.push(r.url), false) });
    ui.handle.open();
    await ui.type('kargo');
    key(ui.input, 'ArrowDown');
    key(ui.input, 'ArrowDown');
    expect(ui.items()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(ui.input.getAttribute('aria-activedescendant')).toBe(ui.items()[1]!.id);
    key(ui.input, 'ArrowUp');
    key(ui.input, 'ArrowUp');
    // Baştan yukarı: sona sarar.
    expect(ui.items()[2]!.getAttribute('aria-selected')).toBe('true');
    key(ui.input, 'Enter');
    await tick();
    expect(selected).toEqual(['https://shop.example.com/sayfa-3']);
    expect(server.calls.find((c) => c.url.endsWith('/search/events'))).toMatchObject({ keepalive: true, body: { query_id: 'ssq_1', url: 'https://shop.example.com/sayfa-3', position: 3 } });
    // onSelect false döndü: SDK gezinmez, pencere kapanır ve odak tetikleyiciye döner.
    expect(ui.handle.isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);

    ui.handle.open();
    expect(ui.handle.isOpen()).toBe(true);
    key(ui.input, 'Escape');
    expect(ui.handle.isOpen()).toBe(false);
    expect(ui.q<HTMLElement>('.overlay').hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('odak pencerede kalır: Tab giriş ve kapat düğmesi arasında döner', async () => {
    const ui = mount(fakeServer());
    ui.handle.open();
    key(ui.input, 'Tab');
    expect(ui.root.activeElement).toBe(ui.q('.icon'));
    key(ui.q('.icon'), 'Tab');
    expect(ui.root.activeElement).toBe(ui.input);
    key(ui.input, 'Tab', { shiftKey: true });
    expect(ui.root.activeElement).toBe(ui.q('.icon'));
  });

  it('AI yanıtı: app ayarı açıksa "sor" görünür; Enter yanıt ister, kaynaklar bağlantı olur', async () => {
    const server = fakeServer((body) =>
      body.mode === 'answer'
        ? { mode: 'answer', answers_available: true, answer_status: 'answered', answer: { text: '500 TL üzeri kargo ücretsiz.', sources: [{ id: 'sdoc_1', url: 'https://shop.example.com/kargo', title: 'Kargo' }, { id: 'sdoc_9', url: 'javascript:alert(1)', title: 'Kötü' }] } }
        : { answers_available: true },
    );
    const ui = mount(server);
    ui.handle.open();
    const ask = ui.q<HTMLButtonElement>('.ask');
    expect(ask.hidden).toBe(true);
    await ui.type('kargo ücreti');
    expect(ask.hidden).toBe(false);
    expect(ask.textContent).toBe('Yapay zekâya sorkargo ücreti');
    // Yazarken yalnız arama modu istenir (maliyet): yanıt ziyaretçi isteyince.
    expect(server.searches().every((c) => c.body.mode === 'search')).toBe(true);
    key(ui.input, 'Enter');
    await tick(20);
    expect(server.searches().at(-1)!.body).toMatchObject({ query: 'kargo ücreti', mode: 'answer' });
    const answer = ui.q<HTMLElement>('.answer');
    expect(answer.hidden).toBe(false);
    expect(answer.getAttribute('aria-live')).toBe('polite');
    expect(answer.querySelector('p')!.textContent).toBe('500 TL üzeri kargo ücretsiz.');
    expect(Array.from(answer.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://shop.example.com/kargo']);
    expect(answer.querySelector('.note')!.textContent).toContain('Yapay zekâ');
    // Aynı sorgu için "sor" yeniden gösterilmez; ikinci Enter yalnız arar.
    expect(ask.hidden).toBe(true);
    key(ui.input, 'Enter');
    await tick(20);
    expect(server.searches().at(-1)!.body.mode).toBe('search');
  });

  it('AI yanıtı: içerikte yoksa "bulunamadı", verilemezse sonuçlara yönlendirir; answers:false ise hiç sorulmaz', async () => {
    const notFound = mount(fakeServer((body) => (body.mode === 'answer' ? { mode: 'answer', answer_status: 'not_found', answers_available: true } : { answers_available: true })), { answers: true });
    notFound.handle.open();
    await notFound.type('garanti');
    notFound.q<HTMLButtonElement>('.ask').click();
    await tick(20);
    expect(notFound.q('.answer p').textContent).toBe('Bu sorunun yanıtı site içeriğinde bulunamadı.');
    notFound.handle.destroy();
    expect(document.querySelector('[data-pushizo-search]')).toBeNull();

    // Sunucu sessizce arama moduna düştü (kota/tavan): sonuçlar yine listelenir.
    const fallback = mount(fakeServer(() => ({ mode: 'search', answer: null, answer_status: null, answers_available: true })), { answers: true });
    fallback.handle.open();
    await fallback.type('kargo');
    key(fallback.input, 'Enter');
    await tick(20);
    expect(fallback.q('.answer p').textContent).toContain('Şu an yanıt oluşturulamıyor');
    expect(fallback.items()).toHaveLength(3);
    fallback.handle.destroy();

    const off = fakeServer(() => ({ answers_available: true }));
    const disabled = mount(off, { answers: false });
    disabled.handle.open();
    await disabled.type('kargo');
    expect(disabled.q<HTMLButtonElement>('.ask').hidden).toBe(true);
    key(disabled.input, 'Enter');
    await tick(20);
    expect(off.searches().every((c) => c.body.mode === 'search')).toBe(true);
  });

  it('sonuç yok ve hata durumları', async () => {
    const empty = mount(fakeServer(() => ({ results: [] })));
    empty.handle.open();
    await empty.type('uzay');
    expect(empty.q('[role="status"]').textContent).toBe('Sonuç bulunamadı.');
    expect(empty.input.getAttribute('aria-expanded')).toBe('false');
    empty.handle.destroy();
    const failing = mount(fakeServer(() => 403));
    failing.handle.open();
    await failing.type('kargo');
    expect(failing.q('[role="status"]').textContent).toBe('Arama yapılamadı. Lütfen tekrar deneyin.');
    expect(failing.items()).toHaveLength(0);
  });

  it('kısayol: Ctrl/⌘+K açar-kapatır; open(query) sorguyu doldurup arar', async () => {
    const server = fakeServer();
    const ui = mount(server, { hotkey: true });
    key(document, 'k', { ctrlKey: true });
    expect(ui.handle.isOpen()).toBe(true);
    key(document, 'k', { metaKey: true });
    expect(ui.handle.isOpen()).toBe(false);
    ui.handle.open('iade');
    await tick(20);
    expect(ui.input.value).toBe('iade');
    expect(server.searches().at(-1)!.body.query).toBe('iade');
    ui.handle.destroy();
    key(document, 'k', { ctrlKey: true });
    expect(document.querySelector('[data-pushizo-search]')).toBeNull();
  });
});

describe('tembel yükleme ve paket sınırı', () => {
  it('pencere betiği bir kez yüklenir', async () => {
    const mountFn = vi.fn((): SearchWidgetHandle => ({ open: () => undefined, close: () => undefined, isOpen: () => false, destroy: () => undefined }));
    const appended: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      appended.push(node as HTMLScriptElement);
      (globalThis as unknown as { PushizoSearchWidget: unknown }).PushizoSearchWidget = { mount: mountFn };
      queueMicrotask(() => {
        (node as HTMLScriptElement).onload?.(new Event('load'));
      });
      return node;
    });
    const [a, b] = await Promise.all([loadSearchWidget('https://api.test/sdk-web/PushizoSearch.js', 'n1'), loadSearchWidget('https://api.test/sdk-web/PushizoSearch.js')]);
    expect(a).toBe(b);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ src: 'https://api.test/sdk-web/PushizoSearch.js', nonce: 'n1', async: true });
    delete (globalThis as unknown as { PushizoSearchWidget?: unknown }).PushizoSearchWidget;
    delete (globalThis as unknown as { __hsSearchWidgetLoad?: unknown }).__hsSearchWidgetLoad;
    vi.restoreAllMocks();
  });

  it('ana paket arama penceresini içermez (ayrı paket) ve boyut bütçesi tanımlıdır', async () => {
    const fs = await vi.importActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('node:fs');
    const path = await vi.importActual<{ resolve(...parts: string[]): string }>('node:path');
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    // Ana SDK yalnız istemciyi ve yükleyiciyi içe aktarır; pencere modülüne statik bağ yok.
    const sdk = read('../sdk.ts');
    expect(sdk).toContain("from './core/search.js'");
    expect(sdk).not.toMatch(/search-widget/);
    expect(read('../core/search.ts')).not.toMatch(/from '\.\.\/search-widget/);
    const budget = JSON.parse(read('../../size-budget.json')) as { files: Record<string, number> };
    expect(budget.files['dist/PushizoSearch.js']).toBeLessThanOrEqual(8 * 1024);
    // Ana paket bütçeleri bu fazda büyütülmedi.
    expect(budget.files['dist/PushizoSDK.js']).toBe(43008);
    expect(budget.files['dist/index.js']).toBe(69632);
    expect(read('../../build.mjs')).toContain("outfile: 'dist/PushizoSearch.js'");
  });
});
