import { ApiError, queryString, type SdkApi } from '../core/api.js';
import type { Logger } from '../core/logger.js';
import type { WebCampaign, WebCampaignDisplay, WebCampaignEvent, WebCampaignList } from '../core/types.js';
import {
  chooseVariant,
  deviceKind,
  frequencyAllows,
  matchConditions,
  recordShown,
  targetingMatches,
  utmOf,
  type SessionState,
  type VisitorState,
} from '../core/web-campaign-logic.js';
import type * as Render from './web-campaign-render.js';
import type { ButtonBlock, RenderedWebCampaign, SubmitOutcome } from './web-campaign-render.js';

/** CDN (IIFE) derlemesinde `true`: çizim modülü ayrı pakette (`PushizoWebCampaigns.js`) tembel yüklenir. */
declare const __HS_LAZY_WC__: boolean | undefined;
type RenderFn = typeof Render.renderWebCampaign;

/** Çizim modülü: CDN derlemesinde betik etiketiyle (tek yükleme), paketleyici derlemelerinde doğrudan modül. */
function loadRenderer(url: string): Promise<RenderFn> {
  if (typeof __HS_LAZY_WC__ === 'boolean' && __HS_LAZY_WC__) {
    const w = globalThis as unknown as { PushizoWebCampaignRender?: { render: RenderFn }; __hsWcLoad?: Promise<RenderFn> };
    if (w.PushizoWebCampaignRender) return Promise.resolve(w.PushizoWebCampaignRender.render);
    w.__hsWcLoad ??= new Promise<RenderFn>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => (w.PushizoWebCampaignRender ? resolve(w.PushizoWebCampaignRender.render) : reject(new Error('web kampanyası paketi yüklenemedi')));
      script.onerror = () => {
        w.__hsWcLoad = undefined;
        reject(new Error(`web kampanyası paketi yüklenemedi: ${url}`));
      };
      document.head.appendChild(script);
    });
    return w.__hsWcLoad;
  } else {
    return import('./web-campaign-render.js').then((m) => m.renderWebCampaign);
  }
}

export interface WebCampaignDeps {
  api: () => SdkApi | null;
  appId: () => string | null;
  logger: Logger;
  language: () => string;
  subscriptionId: () => string | null;
  ownershipHash: (subscriptionId: string) => string | null;
  addTags: (tags: Record<string, string>) => unknown;
  requestPushPermission: () => Promise<unknown>;
  sendOutcome: (name: string, value?: number) => unknown;
  /** Tembel çizim paketinin adresi (CDN derlemesi). */
  rendererUrl: () => string;
}

type Listener = (event: WebCampaignEvent) => void;

/** Mobil çıkış niyeti: sayfanın en az bu kadarı kaydırıldıktan sonra hızlı yukarı kaydırma. */
const EXIT_SCROLL_MIN = 0.3;
const EXIT_VELOCITY = 1.2;

function readJson<T>(storage: () => Storage, key: string): T | null {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    /* depolama kapalı (gizli mod): yalnızca bellek */
  }
}

function newVisitorId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

/**
 * Web kampanyası yöneticisi (ADR-0039): liste (60 sn önbellek + ETag; yayın 1 dk içinde yansır), sayfa/ziyaret
 * koşulları, tetikler (sayfa yükleme, süre, kaydırma, çıkış niyeti), sıklık sınırı, A/B, gösterim ve olaylar, gömülü
 * form/anket gönderimi. Tek seferde tek kampanya gösterilir; SPA adres değişiminde koşullar yeniden değerlendirilir.
 */
export class WebCampaignManager {
  readonly listeners = new Set<Listener>();
  paused = false;
  private list: WebCampaignList | null = null;
  private visitor: VisitorState | null = null;
  private session: SessionState | null = null;
  private current: { campaign: WebCampaign; variantId: string | null; view: RenderedWebCampaign } | null = null;
  private cleanups: (() => void)[] = [];
  private href = '';
  private watch: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private loading = false;
  private renderer: RenderFn | null = null;

  constructor(private readonly deps: WebCampaignDeps) {}

  private get key(): string {
    return `pushizo:wc:${this.deps.appId() ?? ''}`;
  }

  private persist(): void {
    if (this.visitor) writeJson(() => window.localStorage, this.key, this.visitor);
    if (this.session) writeJson(() => window.sessionStorage, this.key, this.session);
  }

  /** Ziyaretçi ve oturum durumu: yeni oturumda ziyaret sayısı artar ve ilk sayfanın UTM değerleri saklanır. */
  private loadState(): void {
    const v = readJson<VisitorState>(() => window.localStorage, this.key);
    this.visitor = v && typeof v.id === 'string' ? v : { id: newVisitorId(), visits: 0, c: {} };
    const s = readJson<SessionState>(() => window.sessionStorage, this.key);
    if (s && s.shown) this.session = s;
    else {
      this.visitor.visits++;
      this.session = { utm: utmOf(window.location.search), shown: {} };
    }
    this.persist();
  }

  get visitorId(): string {
    return this.visitor?.id ?? '';
  }

  async start(): Promise<void> {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.loadState();
    await this.refresh();
    // SPA: adres değişimi (pushState/popstate) koşulları yeniden değerlendirir.
    this.href = window.location.href;
    this.watch = setInterval(() => {
      if (window.location.href !== this.href) {
        this.href = window.location.href;
        this.arm();
      }
    }, 1000);
  }

  private proof(): Record<string, string> {
    const sub = this.deps.subscriptionId();
    const hash = sub ? this.deps.ownershipHash(sub) : null;
    // Sahiplik kanıtı olmadan abonelik kimliği gönderilmez (sunucu 403 verir); ziyaretçi anonim kalır.
    return sub && hash && /^[0-9a-f]{64}$/.test(hash) ? { subscription_id: sub, token_hash: hash } : {};
  }

  async refresh(): Promise<void> {
    const api = this.deps.api();
    if (!api) return;
    try {
      this.list = await api.request<WebCampaignList>('GET', `/web-campaigns${queryString({ language: this.deps.language().split('-')[0], ...this.proof() })}`);
    } catch (err) {
      this.deps.logger.warn('web kampanyaları alınamadı', err);
      return;
    }
    this.arm();
  }

  private disarm(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }

  /** Uygun kampanyaların tetiklerini kurar (öncelik sırasıyla; ilk tetiklenen gösterilir). */
  private arm(): void {
    this.disarm();
    if (!this.list || !this.visitor || !this.session) return;
    const now = Date.now();
    const page = { path: window.location.pathname + window.location.search, href: window.location.href, utm: this.session.utm, visits: this.visitor.visits };
    const device = deviceKind(navigator.userAgent, window.innerWidth);
    const eligible = [...this.list.data]
      .sort((a, b) => b.priority - a.priority)
      .filter(
        (c) =>
          (!c.end_at || Date.parse(c.end_at) > now) &&
          matchConditions(c.conditions, page) &&
          targetingMatches(c.targeting, this.visitor!.visits, device) &&
          frequencyAllows(c.frequency, c.id, this.visitor!, this.session!, now),
      );
    if (eligible.length) void this.ensureRenderer().catch(() => undefined);
    for (const c of eligible) this.cleanups.push(this.trigger(c, () => void this.show(c)));
  }

  private async ensureRenderer(): Promise<RenderFn> {
    this.renderer ??= await loadRenderer(this.deps.rendererUrl());
    return this.renderer;
  }

  private trigger(c: WebCampaign, fire: () => void): () => void {
    const t = c.trigger;
    if (t.kind === 'page_load' || t.kind === 'time_on_page') {
      const ms = (t.kind === 'page_load' ? (t.delay_seconds ?? 0) : t.seconds) * 1000;
      const id = setTimeout(fire, ms);
      return () => clearTimeout(id);
    }
    if (t.kind === 'scroll_depth') {
      const check = () => {
        const doc = document.documentElement;
        const max = Math.max(doc.scrollHeight - window.innerHeight, 1);
        if ((window.scrollY / max) * 100 >= t.percent) fire();
      };
      window.addEventListener('scroll', check, { passive: true });
      return () => window.removeEventListener('scroll', check);
    }
    // Çıkış niyeti: masaüstünde imleç pencerenin üstünden çıkar; dokunmatikte hızlı yukarı kaydırma.
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget && e.clientY <= 0) fire();
    };
    let lastY = window.scrollY;
    let lastT = Date.now();
    const onScroll = () => {
      const y = window.scrollY;
      const now = Date.now();
      const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      if (lastY / max >= EXIT_SCROLL_MIN && (lastY - y) / Math.max(now - lastT, 1) > EXIT_VELOCITY) fire();
      lastY = y;
      lastT = now;
    };
    document.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', onScroll);
    };
  }

  /** Kampanyayı gösterir (`force`: `WebCampaigns.show` ile koşullar ve sıklık atlanır). */
  async show(c: WebCampaign, force = false): Promise<boolean> {
    if (this.current || this.loading || (this.paused && !force) || !this.visitor || !this.session || !this.list) return false;
    if (!force && !frequencyAllows(c.frequency, c.id, this.visitor, this.session, Date.now())) return false;
    let renderWebCampaign: RenderFn;
    this.loading = true;
    try {
      renderWebCampaign = await this.ensureRenderer();
    } catch (err) {
      this.deps.logger.warn('web kampanyası gösterilemedi', err);
      return false;
    } finally {
      this.loading = false;
    }
    if (this.current) return false;
    const variant = chooseVariant(c.variants, this.visitor.id, c.id);
    const display: WebCampaignDisplay = variant?.display ?? c.display;
    const variantId = variant?.id ?? null;
    const lang = this.list.language;
    const view = renderWebCampaign(display, {
      language: lang,
      form: display.form_id ? this.list.forms[display.form_id] : null,
      survey: display.survey_id ? this.list.surveys[display.survey_id] : null,
      onButton: (b) => this.onButton(c, variantId, b),
      onClose: () => this.close(true),
      onAutoClose: () => this.close(false),
      onForm: (values, elapsed) => this.submitForm(c, variantId, display.form_id!, values, elapsed, lang),
      onSurvey: (answers) => this.submitSurvey(c, display.survey_id!, answers),
    });
    this.current = { campaign: c, variantId, view };
    recordShown(c.id, this.visitor, this.session, Date.now());
    this.persist();
    this.disarm();
    this.post(c.id, { type: 'impression', variant_id: variantId ?? undefined });
    this.emit({ type: 'show', campaignId: c.id, variantId });
    return true;
  }

  /** Kimliğe göre gösterim (koşullar atlanır). */
  showById(id: string): Promise<boolean> {
    const c = this.list?.data.find((x) => x.id === id);
    return c ? this.show(c, true) : Promise.resolve(false);
  }

  private close(byUser: boolean): void {
    const cur = this.current;
    if (!cur) return;
    cur.view.close();
    this.current = null;
    if (byUser) {
      const h = this.visitor?.c[cur.campaign.id];
      if (h) h.x = Date.now();
      this.persist();
      this.post(cur.campaign.id, { type: 'close', variant_id: cur.variantId ?? undefined });
      this.emit({ type: 'close', campaignId: cur.campaign.id, variantId: cur.variantId });
    }
    this.arm();
  }

  private onButton(c: WebCampaign, variantId: string | null, b: ButtonBlock): void {
    this.post(c.id, { type: 'click', button_id: b.id, variant_id: variantId ?? undefined });
    this.emit({ type: 'click', campaignId: c.id, variantId, buttonId: b.id });
    const a = b.action;
    if (a.type === 'push_prompt') void this.deps.requestPushPermission().catch(() => undefined);
    else if (a.type === 'outcome') void this.deps.sendOutcome(a.name, a.value);
    else if (a.type === 'tags') void this.deps.addTags(a.tags);
    // Tıklama kapatma sayılmaz: kapatma süresi (hide_after_close_days) yalnızca kullanıcı kapatmasında işler.
    const cur = this.current;
    if (cur) {
      cur.view.close();
      this.current = null;
    }
    if (a.type === 'url') {
      if (a.new_tab) window.open(a.url, '_blank', 'noopener');
      else window.location.assign(a.url);
    }
    this.arm();
  }

  private converted(c: WebCampaign): void {
    const h = this.visitor?.c[c.id];
    if (h) h.v = 1;
    this.persist();
  }

  private async submitForm(c: WebCampaign, variantId: string | null, formId: string, values: Record<string, string | boolean>, elapsed: number, lang: string): Promise<SubmitOutcome> {
    try {
      const res = await this.deps.api()!.request<{ success_message: string; submission_id: string | null; redirect_url: string | null }>('POST', `/forms/${encodeURIComponent(formId)}/submissions`, {
        values,
        visitor_id: this.visitorId,
        web_campaign_id: c.id,
        page_url: window.location.href.slice(0, 2000),
        language: lang,
        elapsed_ms: elapsed,
        ...this.proof(),
      });
      this.converted(c);
      this.emit({ type: 'submit', campaignId: c.id, variantId, resultId: res.submission_id });
      if (res.redirect_url) setTimeout(() => window.location.assign(res.redirect_url!), 1200);
      return { ok: true, message: res.success_message };
    } catch (err) {
      return this.failure(err);
    }
  }

  private async submitSurvey(c: WebCampaign, surveyId: string, answers: Record<string, number | string | string[]>): Promise<SubmitOutcome> {
    try {
      const res = await this.deps.api()!.request<{ thank_you: string; response_id: string | null }>('POST', `/surveys/${encodeURIComponent(surveyId)}/responses`, {
        answers,
        visitor_id: this.visitorId,
        web_campaign_id: c.id,
        ...this.proof(),
      });
      this.converted(c);
      this.emit({ type: 'submit', campaignId: c.id, variantId: this.current?.variantId ?? null, resultId: res.response_id });
      return { ok: true, message: res.thank_you };
    } catch (err) {
      return this.failure(err);
    }
  }

  /** Sunucu doğrulama hataları alan/soru bazında gösterilir; diğer hatalar genel mesajdır. */
  private failure(err: unknown): SubmitOutcome {
    const issues = err instanceof ApiError ? ((err.details?.issues as { field?: string; question?: string; message: string }[] | undefined) ?? []) : [];
    const errors = Object.fromEntries(issues.map((i) => [i.field ?? i.question ?? '', i.message]));
    return { ok: false, message: issues.length ? '' : err instanceof ApiError && err.status === 429 ? 'Too many attempts / Çok fazla deneme' : '', errors };
  }

  private post(campaignId: string, body: Record<string, unknown>): void {
    const api = this.deps.api();
    if (!api) return;
    void api.request('POST', `/web-campaigns/${encodeURIComponent(campaignId)}/events`, { visitor_id: this.visitorId, ...body, ...this.proof() }).catch((err: unknown) => this.deps.logger.debug('web kampanyası olayı gönderilemedi', err));
  }

  private emit(e: WebCampaignEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.deps.logger.error('web kampanyası dinleyicisi hata verdi', err);
      }
    }
  }

  destroy(): void {
    this.disarm();
    if (this.watch) clearInterval(this.watch);
    this.current?.view.close();
    this.current = null;
  }
}
