// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWebCampaign, type WebCampaignRenderOptions } from '../browser/web-campaign-render.js';
import { WebCampaignManager } from '../browser/web-campaigns.js';
import { ApiError, type SdkApi } from '../core/api.js';
import { Logger } from '../core/logger.js';
import type { WebCampaign, WebCampaignDisplay, WebCampaignList } from '../core/types.js';
import {
  chooseVariant,
  deviceKind,
  frequencyAllows,
  globMatch,
  matchConditions,
  recordShown,
  targetingMatches,
  utmOf,
  type SessionState,
  type VisitorState,
} from '../core/web-campaign-logic.js';

const display = (patch: Partial<WebCampaignDisplay> = {}): WebCampaignDisplay => ({
  layout: 'popup',
  position: 'right',
  background_color: null,
  text_color: null,
  dismissible: true,
  auto_dismiss_seconds: null,
  max_width: null,
  blocks: [
    { type: 'title', text: '<img src=x onerror="window.__xss=1">Bültene katıl' },
    { type: 'body', text: '%10 indirim' },
    { type: 'button', id: 'later', text: 'Sonra', action: { type: 'dismiss' }, background_color: null, text_color: null },
  ],
  form_id: null,
  survey_id: null,
  ...patch,
});

const campaign = (patch: Partial<WebCampaign> = {}): WebCampaign => ({
  id: 'wcp_1',
  priority: 0,
  trigger: { kind: 'page_load' },
  conditions: {},
  targeting: { visitor: 'all', devices: [] },
  frequency: {},
  display: display(),
  variants: [],
  end_at: null,
  ...patch,
});

const form = {
  id: 'frm_1',
  fields: [
    { id: 'email', type: 'email' as const, label: 'E-posta', placeholder: null, required: true, options: [], max_length: null, policy_url: null },
    { id: 'kvkk', type: 'consent' as const, label: 'KVKK onayı', placeholder: null, required: true, options: [], max_length: null, policy_url: 'https://shop.test/kvkk' },
  ],
  submit_label: 'Gönder',
  success_message: 'Teşekkürler!',
};
const survey = {
  id: 'srv_1',
  questions: [
    { id: 'nps', type: 'nps' as const, text: 'Tavsiye eder misiniz?', required: true, options: [], low_label: null, high_label: null, placeholder: null },
    { id: 'many', type: 'multiple_choice' as const, text: 'Neler?', required: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], low_label: null, high_label: null, placeholder: null },
    { id: 'why', type: 'text' as const, text: 'Neden?', required: false, options: [], low_label: null, high_label: null, placeholder: null },
  ],
  submit_label: 'Gönder',
  thank_you: 'Sağ olun',
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* yok */
  }
});

describe('web kampanyası karar mantığı', () => {
  it('joker kalıp, URL kuralları (dahil/dışla), UTM ve ziyaret koşulları', () => {
    expect(globMatch('/blog/*', '/blog/yazi-1')).toBe(true);
    expect(globMatch('/blog/*/yorum', '/blog/a/yorum')).toBe(true);
    expect(globMatch('/blog/*', '/shop')).toBe(false);
    expect(globMatch('(.*)+$', '(.*)+$')).toBe(true);
    const page = { path: '/blog/a?utm_source=x', href: 'https://site.test/blog/a?utm_source=x', utm: { utm_source: 'insta' }, visits: 3 };
    expect(matchConditions({ url_rules: [{ op: 'contains', value: '/blog' }] }, page)).toBe(true);
    expect(matchConditions({ url_rules: [{ op: 'starts_with', value: '/shop' }] }, page)).toBe(false);
    expect(matchConditions({ url_rules: [{ op: 'contains', value: '/blog' }, { op: 'not_contains', value: '/blog/a' }] }, page)).toBe(false);
    expect(matchConditions({ utm_rules: [{ param: 'utm_source', op: 'equals', value: 'insta' }] }, page)).toBe(true);
    expect(matchConditions({ utm_rules: [{ param: 'utm_medium', op: 'exists' }] }, page)).toBe(false);
    expect(matchConditions({ visits: { op: 'gte', value: 2 } }, page)).toBe(true);
    expect(matchConditions({ visits: { op: 'eq', value: 1 } }, page)).toBe(false);
    expect(utmOf('?utm_source=a&utm_campaign=kis&x=1')).toEqual({ utm_source: 'a', utm_campaign: 'kis' });
  });

  it('cihaz ve ziyaretçi hedeflemesi', () => {
    expect(deviceKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 390)).toBe('mobile');
    expect(deviceKind('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 820)).toBe('tablet');
    expect(deviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 1440)).toBe('desktop');
    expect(targetingMatches({ visitor: 'new', devices: [] }, 1, 'desktop')).toBe(true);
    expect(targetingMatches({ visitor: 'new', devices: [] }, 2, 'desktop')).toBe(false);
    expect(targetingMatches({ visitor: 'returning', devices: ['mobile'] }, 2, 'desktop')).toBe(false);
  });

  it('sıklık: oturum, gün, toplam, kapatma sonrası bekleme, dönüşüm', () => {
    const now = Date.UTC(2026, 9, 20, 10);
    const v: VisitorState = { id: 'v', visits: 1, c: {} };
    const s: SessionState = { utm: {}, shown: {} };
    const f = { max_per_session: 1, max_per_day: 2, max_total: 3, hide_after_close_days: 1 };
    expect(frequencyAllows(f, 'c', v, s, now)).toBe(true);
    recordShown('c', v, s, now);
    expect(frequencyAllows(f, 'c', v, s, now)).toBe(false);
    s.shown = {};
    recordShown('c', v, s, now);
    s.shown = {};
    expect(frequencyAllows(f, 'c', v, s, now)).toBe(false);
    expect(frequencyAllows(f, 'c', v, s, now + 86_400_000)).toBe(true);
    v.c.c!.x = now + 86_400_000;
    expect(frequencyAllows(f, 'c', v, s, now + 86_400_000 + 1000)).toBe(false);
    v.c.c!.x = undefined;
    v.c.c!.v = 1;
    expect(frequencyAllows({}, 'c', v, s, now + 2 * 86_400_000)).toBe(false);
    expect(frequencyAllows({ stop_after_conversion: false }, 'c', v, s, now + 2 * 86_400_000)).toBe(true);
  });

  it('A/B seçimi deterministik ve ağırlıklara yakın', () => {
    const variants = [
      { id: 'a', weight_percent: 30 },
      { id: 'b', weight_percent: 70 },
    ];
    expect(chooseVariant(variants, 'visitor-1', 'wcp_1')).toBe(chooseVariant(variants, 'visitor-1', 'wcp_1'));
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 2000; i++) counts[chooseVariant(variants, `v${i}`, 'wcp_1')!.id as 'a' | 'b']++;
    expect(counts.a / 2000).toBeGreaterThan(0.24);
    expect(counts.a / 2000).toBeLessThan(0.36);
    expect(chooseVariant([], 'v', 'c')).toBeNull();
  });
});

const opts = (patch: Partial<WebCampaignRenderOptions> = {}): WebCampaignRenderOptions => ({
  language: 'tr',
  onButton: vi.fn(),
  onClose: vi.fn(),
  onAutoClose: vi.fn(),
  ...patch,
});
const shadow = (host: HTMLElement) => host.shadowRoot!;

describe('web kampanyası çizimi ve erişilebilirlik', () => {
  it('pop-up: role=dialog + aria-modal, etiket, metin kaçışı, odak, Esc ve arka plan kapatır, odak geri verilir', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const o = opts();
    const view = renderWebCampaign(display(), o);
    const root = shadow(view.host);
    const card = root.querySelector('[role="dialog"]')!;
    expect(card.getAttribute('aria-modal')).toBe('true');
    const title = root.getElementById(card.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toContain('<img src=x');
    expect(root.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect(root.activeElement?.textContent).toBe('Sonra');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(o.onClose).toHaveBeenCalledTimes(1);
    (root.querySelector('.bd') as HTMLElement).click();
    expect(o.onClose).toHaveBeenCalledTimes(2);
    view.close();
    expect(document.activeElement).toBe(trigger);
  });

  it('odak tuzağı: Tab son öğeden ilke, Shift+Tab ilkten sona döner', () => {
    const view = renderWebCampaign(display(), opts());
    const root = shadow(view.host);
    const items = Array.from(root.querySelectorAll<HTMLElement>('button'));
    items.at(-1)!.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(items[0]);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(back);
    expect(root.activeElement).toBe(items.at(-1));
    view.close();
  });

  it('slide-in ve banner sayfayı engellemez (aria-modal=false, odak çalınmaz) ve kendiliğinden kapanır', () => {
    vi.useFakeTimers();
    const o = opts();
    const view = renderWebCampaign(display({ layout: 'slide_in', position: 'left', auto_dismiss_seconds: 5 }), o);
    const card = shadow(view.host).querySelector('[role="dialog"]')!;
    expect(card.getAttribute('aria-modal')).toBe('false');
    expect(card.className).toContain('si l');
    expect(shadow(view.host).activeElement).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(o.onAutoClose).toHaveBeenCalled();
    view.close();
  });

  it('form: etiketli alanlar, sunucu hataları alana bağlanır (aria-invalid + aria-describedby), başarıda durum metni odaklanır', async () => {
    const onForm = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: '', errors: { email: 'Geçerli bir e-posta girin.' } })
      .mockResolvedValueOnce({ ok: true, message: 'Teşekkürler!' });
    const view = renderWebCampaign(display({ form_id: 'frm_1' }), opts({ form, onForm }));
    const root = shadow(view.host);
    const email = root.querySelector<HTMLInputElement>('input[type="email"]')!;
    expect(root.querySelector(`label[for="${email.id}"]`)!.textContent).toBe('E-posta *');
    expect(email.autocomplete).toBe('email');
    expect(root.querySelector('a[href="https://shop.test/kvkk"]')).not.toBeNull();
    const honeypot = root.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.getAttribute('aria-hidden')).toBe('true');
    email.value = 'kotu';
    root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'));
    expect(onForm.mock.calls[0]![0]).toEqual({ email: 'kotu', kvkk: true });
    expect(root.getElementById(email.getAttribute('aria-describedby')!)!.textContent).toBe('Geçerli bir e-posta girin.');
    email.value = 'a@b.co';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')!.textContent).toBe('Teşekkürler!'));
    expect(root.activeElement?.getAttribute('role')).toBe('status');
    view.close();
  });

  it('anket: NPS ölçeği radyo grubu (legend), çoklu seçim ve metin yanıtları toplanır', async () => {
    const onSurvey = vi.fn().mockResolvedValue({ ok: true, message: 'Sağ olun' });
    const view = renderWebCampaign(display({ survey_id: 'srv_1', blocks: [] }), opts({ survey, onSurvey }));
    const root = shadow(view.host);
    expect(root.querySelector('fieldset legend')!.textContent).toBe('Tavsiye eder misiniz? *');
    const radios = root.querySelectorAll<HTMLInputElement>('input[name="nps"]');
    expect(radios).toHaveLength(11);
    radios[9]!.checked = true;
    root.querySelectorAll<HTMLInputElement>('input[name="many"]').forEach((c) => (c.checked = true));
    root.querySelector<HTMLTextAreaElement>('textarea[name="why"]')!.value = ' hızlı ';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(onSurvey).toHaveBeenCalled());
    expect(onSurvey.mock.calls[0]![0]).toEqual({ nps: 9, many: ['a', 'b'], why: 'hızlı' });
    view.close();
  });
});

describe('web kampanyası yöneticisi', () => {
  const list = (data: WebCampaign[]): WebCampaignList => ({ data, forms: { frm_1: form }, surveys: {}, language: 'tr' });

  function manager(response: WebCampaignList, handler?: (method: string, path: string, body?: unknown) => unknown) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api = {
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (method === 'GET') return response;
        return handler ? handler(method, path, body) : { ok: true };
      }),
    } as unknown as SdkApi;
    const m = new WebCampaignManager({
      api: () => api,
      appId: () => 'app_1',
      logger: new Logger(),
      language: () => 'tr-TR',
      subscriptionId: () => null,
      ownershipHash: () => null,
      addTags: vi.fn(),
      requestPushPermission: vi.fn().mockResolvedValue(undefined),
      sendOutcome: vi.fn(),
      rendererUrl: () => 'https://api.test/sdk-web/PushizoWebCampaigns.js',
    });
    return { m, calls };
  }

  it('liste dil ile alınır; sayfa yüklenince gösterilir, gösterim ve kapatma olayları gider, sıklık uygulanır', async () => {
    const { m, calls } = manager(list([campaign({ frequency: { max_per_session: 1 } })]));
    await m.start();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/web-campaigns?language=tr' });
    await vi.waitFor(() => expect(document.querySelector('[data-hs-web-campaign="popup"]')).not.toBeNull());
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/web-campaigns/wcp_1/events' && (c.body as { type: string }).type === 'impression')).toBe(true));
    const root = (document.querySelector('[data-hs-web-campaign]') as HTMLElement).shadowRoot!;
    (root.querySelector('.x') as HTMLButtonElement).click();
    expect(document.querySelector('[data-hs-web-campaign]')).toBeNull();
    expect(calls.some((c) => (c.body as { type?: string })?.type === 'close')).toBe(true);
    const visitorId = (calls.find((c) => c.method === 'POST')!.body as { visitor_id: string }).visitor_id;
    expect(visitorId).toMatch(/^[a-z0-9]{16,20}$/);
    // Oturum sınırı: yeniden değerlendirmede gösterilmez.
    await m.refresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-hs-web-campaign]')).toBeNull();
    m.destroy();
  });

  it('beklenmeyen liste yanıtı (data dizisi değil) hata fırlatmaz ve kampanya göstermez', async () => {
    for (const bad of [{} as WebCampaignList, null as unknown as WebCampaignList, { data: 'x' } as unknown as WebCampaignList]) {
      const { m } = manager(bad);
      await expect(m.start()).resolves.toBeUndefined();
      await expect(m.refresh()).resolves.toBeUndefined();
      expect(document.querySelector('[data-hs-web-campaign]')).toBeNull();
      m.destroy();
    }
  });

  it('URL koşulu sağlanmazsa gösterilmez; WebCampaigns.show koşulları atlar', async () => {
    const { m } = manager(list([campaign({ conditions: { url_rules: [{ op: 'starts_with', value: '/kampanya' }] } })]));
    await m.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-hs-web-campaign]')).toBeNull();
    expect(await m.showById('wcp_1')).toBe(true);
    expect(document.querySelector('[data-hs-web-campaign]')).not.toBeNull();
    m.destroy();
  });

  it('form gönderimi kampanya kimliği, ziyaretçi ve doldurma süresiyle gider; doğrulama hataları alanlara dağıtılır', async () => {
    let attempt = 0;
    const { m, calls } = manager(list([campaign({ display: display({ form_id: 'frm_1', blocks: [] }) })]), (_method, path) => {
      if (!path.startsWith('/forms/')) return { ok: true };
      attempt++;
      if (attempt === 1) throw new ApiError(400, 'HS_VALIDATION_ERROR', 'x', { issues: [{ field: 'email', code: 'invalid_email', message: 'Geçersiz e-posta' }] });
      return { ok: true, status: 'accepted', submission_id: 'fsb_1', success_message: 'Kaydınız alındı', redirect_url: null };
    });
    const events: string[] = [];
    m.listeners.add((e) => events.push(e.type));
    await m.start();
    await vi.waitFor(() => expect(document.querySelector('[data-hs-web-campaign]')).not.toBeNull());
    const root = (document.querySelector('[data-hs-web-campaign]') as HTMLElement).shadowRoot!;
    const email = root.querySelector<HTMLInputElement>('input[type="email"]')!;
    email.value = 'x';
    root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'));
    email.value = 'a@b.co';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')!.textContent).toBe('Kaydınız alındı'));
    const sent = calls.filter((c) => c.path === '/forms/frm_1/submissions').at(-1)!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ values: { email: 'a@b.co', kvkk: true }, web_campaign_id: 'wcp_1', language: 'tr' });
    expect(typeof sent.elapsed_ms).toBe('number');
    expect(sent.subscription_id).toBeUndefined();
    expect(events).toEqual(['show', 'submit']);
    m.destroy();
  });
});
