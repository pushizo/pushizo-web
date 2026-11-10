// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalizationManager } from '../browser/personalization.js';
import type { SdkApi } from '../core/api.js';
import { Logger } from '../core/logger.js';
import { eligiblePersonalizations, pageGoalMatches, resolvePersonalization, safeUrl } from '../core/personalization-logic.js';
import { buildSelector } from '../core/selector.js';
import type { PersonalizationChange, WebPersonalization, WebPersonalizationList } from '../core/types.js';

const change = (patch: Partial<PersonalizationChange>): PersonalizationChange => ({ selector: 'h1', action: 'text', text: null, url: null, alt: null, new_tab: false, ...patch });

const exp = (patch: Partial<WebPersonalization> = {}): WebPersonalization => ({
  id: 'wpz_1',
  priority: 0,
  conditions: {},
  targeting: { visitor: 'all', devices: [] },
  changes: [change({ selector: '#hero h1', text: '<img src=x onerror="window.__xss=1">Size özel' })],
  variants: [],
  winner_variant_id: null,
  goal: null,
  end_at: null,
  ...patch,
});

describe('kişiselleştirme mantığı', () => {
  it('güvenli adres: yalnız http(s) ve göreli yol', () => {
    expect(safeUrl('https://a.example.com/x')).toBe('https://a.example.com/x');
    expect(safeUrl('/kampanya?x=1')).toBe('/kampanya?x=1');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.example.com', 'vbscript:x', ' https://a', null]) expect(safeUrl(bad)).toBeNull();
  });

  it('koşul, cihaz, bitiş ve öncelik', () => {
    const page = { path: '/urun/1', href: 'https://site.test/urun/1', utm: {}, visits: 1 };
    const list = [
      exp({ id: 'a', priority: 1, conditions: { url_rules: [{ op: 'starts_with', value: '/urun' }] } }),
      exp({ id: 'b', priority: 5 }),
      exp({ id: 'c', conditions: { url_rules: [{ op: 'starts_with', value: '/blog' }] } }),
      exp({ id: 'd', targeting: { visitor: 'returning', devices: [] } }),
      exp({ id: 'e', targeting: { visitor: 'all', devices: ['mobile'] } }),
      exp({ id: 'f', end_at: new Date(Date.now() - 1000).toISOString() }),
    ];
    expect(eligiblePersonalizations(list, page, 'desktop', Date.now()).map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('varyant deterministik; kontrol grubunda değişiklik yok; kazanan kimliği raporlanır', () => {
    const ab = exp({ variants: [{ id: 'control', weight_percent: 50, changes: [] }, { id: 'b', weight_percent: 50, changes: [change({ text: 'B' })] }] });
    const r1 = resolvePersonalization(ab, 'visitor-1');
    expect(resolvePersonalization(ab, 'visitor-1')).toEqual(r1);
    const seen = new Set(Array.from({ length: 40 }, (_, i) => resolvePersonalization(ab, `v-${i}`).variantId));
    expect(seen).toEqual(new Set(['control', 'b']));
    expect(resolvePersonalization(exp({ winner_variant_id: 'b' }), 'v')).toMatchObject({ variantId: 'b' });
    expect(pageGoalMatches({ type: 'page', url: { op: 'contains', value: '/tesekkurler' } }, '/siparis/tesekkurler', '')).toBe(true);
    expect(pageGoalMatches({ type: 'click', selector: 'a' }, '/x', '')).toBe(false);
  });
});

describe('seçici üretimi', () => {
  it('kimlik, test özniteliği ve tekil yol', () => {
    document.body.innerHTML = `
      <section id="hero"><h1>Başlık</h1></section>
      <ul class="list"><li class="item">1</li><li class="item">2</li></ul>
      <button data-testid="buy">Al</button>`;
    expect(buildSelector(document.querySelector('#hero')!)).toBe('#hero');
    expect(buildSelector(document.querySelector('button')!)).toBe('[data-testid="buy"]');
    const second = document.querySelectorAll('li')[1]!;
    const sel = buildSelector(second);
    expect(document.querySelectorAll(sel)).toHaveLength(1);
    expect(document.querySelector(sel)).toBe(second);
    expect(sel).not.toMatch(/[<{};]/);
  });
});

describe('PersonalizationManager', () => {
  let calls: { method: string; path: string; body?: unknown }[];
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = 'pushizo-af';
    document.body.innerHTML = `
      <section id="hero"><h1>Varsayılan başlık</h1><img class="banner" src="https://cdn.test/old.png" srcset="https://cdn.test/old2.png 2x" alt="eski"></section>
      <a class="cta" href="/eski">Eski</a>
      <div class="newsletter">Bülten</div>`;
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => vi.restoreAllMocks());

  function manager(list: WebPersonalizationList) {
    calls = [];
    const api = {
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        return method === 'GET' ? list : { ok: true };
      }),
    } as unknown as SdkApi;
    return new PersonalizationManager({
      api: () => api,
      appId: () => 'app_1',
      logger: new Logger(),
      language: () => 'tr-TR',
      subscriptionId: () => null,
      ownershipHash: () => null,
      editorUrl: () => 'https://api.test/sdk-web/PushizoVisualEditor.js',
    });
  }
  const list = (data: WebPersonalization[]): WebPersonalizationList => ({ data, editor_origins: ['https://panel.test'], language: 'tr' });

  it('değişiklikler textContent/öznitelikle uygulanır (XSS yok), maruz kalma bir kez gider, titreme gizlemesi kalkar', async () => {
    const m = manager(
      list([
        exp({
          changes: [
            change({ selector: '#hero h1', text: '<img src=x onerror="window.__xss=1">Size özel' }),
            change({ selector: 'img.banner', action: 'image', url: 'https://cdn.test/new.png', alt: 'yeni' }),
            change({ selector: 'a.cta', action: 'link', url: 'javascript:alert(1)', text: 'Kötü' }),
            change({ selector: '.newsletter', action: 'hide' }),
            change({ selector: '{{bozuk', action: 'hide' }),
          ],
        }),
      ]),
    );
    m.start();
    void m.load();
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/web-personalizations/wpz_1/events')).toBe(true));
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/web-personalizations?language=tr' });
    const h1 = document.querySelector('#hero h1')!;
    expect(h1.textContent).toBe('<img src=x onerror="window.__xss=1">Size özel');
    expect(h1.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    const img = document.querySelector('img.banner')!;
    expect(img.getAttribute('src')).toBe('https://cdn.test/new.png');
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(img.getAttribute('alt')).toBe('yeni');
    // Güvensiz adresli bağlantı değişikliği uygulanmaz.
    expect(document.querySelector('a.cta')!.getAttribute('href')).toBe('/eski');
    expect(document.querySelector('a.cta')!.textContent).toBe('Eski');
    expect((document.querySelector('.newsletter') as HTMLElement).style.display).toBe('none');
    expect(document.documentElement.classList.contains('pushizo-af')).toBe(false);
    expect(calls.filter((c) => c.path === '/web-personalizations/wpz_1/events')).toHaveLength(1);
    // Liste önbelleklenir (sonraki sayfa yüklemesi ağı beklemeden uygular).
    expect(localStorage.getItem('pushizo:pz:app_1:list')).toContain('wpz_1');
    m.destroy();
    // Geri alma: özgün değerler döner.
    expect(h1.textContent).toBe('Varsayılan başlık');
    expect(img.getAttribute('src')).toBe('https://cdn.test/old.png');
    expect(img.getAttribute('srcset')).toBe('https://cdn.test/old2.png 2x');
    expect((document.querySelector('.newsletter') as HTMLElement).style.display).toBe('');
  });

  it('koşulu sağlamayan sayfada uygulanmaz; sonradan eklenen öğe yakalanır', async () => {
    const m = manager(list([exp({ id: 'wpz_blog', conditions: { url_rules: [{ op: 'starts_with', value: '/blog' }] }, changes: [change({ selector: '.late', text: 'Geç öğe' })] })]));
    m.start();
    void m.load();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    m.destroy();
    window.history.replaceState({}, '', '/blog/yazi');
    const m2 = manager(list([exp({ id: 'wpz_blog', conditions: { url_rules: [{ op: 'starts_with', value: '/blog' }] }, changes: [change({ selector: '.late', text: 'Geç öğe' })] })]));
    m2.start();
    void m2.load();
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const late = document.createElement('p');
    late.className = 'late';
    late.textContent = 'ilk';
    document.body.appendChild(late);
    await vi.waitFor(() => expect(late.textContent).toBe('Geç öğe'));
    m2.destroy();
  });

  it('dönüşüm: olay ve tıklama hedefi yalnız maruz kalmışta ve bir kez; varyant kimliğiyle', async () => {
    const m = manager(
      list([
        exp({ id: 'wpz_ev', goal: { type: 'event', event: 'purchase' }, variants: [{ id: 'a', weight_percent: 50, changes: [change({ text: 'A' })] }, { id: 'b', weight_percent: 50, changes: [change({ text: 'B' })] }] }),
        exp({ id: 'wpz_click', goal: { type: 'click', selector: 'a.cta' } }),
        exp({ id: 'wpz_other', goal: { type: 'event', event: 'purchase' }, conditions: { url_rules: [{ op: 'starts_with', value: '/yok' }] } }),
      ]),
    );
    m.start();
    void m.load();
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    const variant = (calls.find((c) => c.path === '/web-personalizations/wpz_ev/events')!.body as { variant_id: string }).variant_id;
    m.onEvent('purchase');
    m.onEvent('purchase');
    (document.querySelector('a.cta') as HTMLElement).click();
    const conversions = calls.filter((c) => (c.body as { type?: string } | undefined)?.type === 'conversion');
    expect(conversions.map((c) => c.path).sort()).toEqual(['/web-personalizations/wpz_click/events', '/web-personalizations/wpz_ev/events']);
    expect((conversions.find((c) => c.path.includes('wpz_ev'))!.body as { variant_id: string }).variant_id).toBe(variant);
    m.destroy();
  });
});
