import { queryString, type SdkApi } from '../core/api.js';
import type { Logger } from '../core/logger.js';
import { eligiblePersonalizations, pageGoalMatches, resolvePersonalization, safeUrl } from '../core/personalization-logic.js';
import type { PersonalizationChange, WebPersonalization, WebPersonalizationList } from '../core/types.js';
import { deviceKind } from '../core/web-campaign-logic.js';
import { loadVisitorState, readJson, writeJson } from './web-campaigns.js';

export interface PersonalizationDeps {
  api: () => SdkApi | null;
  appId: () => string | null;
  logger: Logger;
  language: () => string;
  subscriptionId: () => string | null;
  ownershipHash: (subscriptionId: string) => string | null;
  /** Görsel seçici paketinin adresi. */
  editorUrl: () => string;
}

/** Titreme önleme parçacığının `<html>` sınıfı (belgelenmiş; SDK uygulama sonrası kaldırır). */
const ANTI_FLICKER_CLASS = 'pushizo-af';

/** Değişiklikten önceki özgün değerler (geri alma için). */
interface Original {
  text?: string | null;
  attrs?: Record<string, string | null>;
  display?: [string, string];
}

/** Ziyaretçi başına kalıcı durum: maruz kalınan deneyim → varyant, dönüşen deneyimler. */
interface PzState {
  e: Record<string, string>;
  v: Record<string, 1>;
}

/**
 * Web kişiselleştirme yöneticisi (ADR-0083): liste (60 sn önbellek + ETag, son liste yerelde saklanır ve başlangıçta
 * ağı beklemeden uygulanır), sayfa koşulları, varyant, değişikliklerin uygulanması/geri alınması, sonradan oluşan öğeler
 * (MutationObserver), maruz kalma ve dönüşüm olayları, görsel seçici. HTML yazılmaz: yalnız `textContent` ve öznitelik.
 */
export class PersonalizationManager {
  private list: WebPersonalizationList | null = null;
  private visitorId = '';
  private visits = 1;
  private state: PzState = { e: {}, v: {} };
  private seen = new Set<string>();
  private active: { p: WebPersonalization; variantId: string | null; changes: PersonalizationChange[] }[] = [];
  private originals = new Map<Element, Original>();
  private touched = new Map<Element, Set<string>>();
  private observer: MutationObserver | null = null;
  private href = '';
  private watch: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private readonly deps: PersonalizationDeps) {}

  private get key(): string {
    return `pushizo:pz:${this.deps.appId() ?? ''}`;
  }

  start(): void {
    if (this.started || typeof window === 'undefined' || typeof document === 'undefined') return;
    this.started = true;
    const { visitor } = loadVisitorState(this.deps.appId() ?? '');
    this.visitorId = visitor.id;
    this.visits = visitor.visits;
    this.state = readJson<PzState>(() => window.localStorage, this.key) ?? { e: {}, v: {} };
    this.seen = new Set(readJson<string[]>(() => window.sessionStorage, this.key) ?? []);
    // Önbellekteki son liste hemen uygulanır (titreme önleme); güncel liste gelince yeniden değerlendirilir.
    const cached = readJson<WebPersonalizationList>(() => window.localStorage, `${this.key}:list`);
    if (cached && Array.isArray(cached.data)) {
      this.list = cached;
      this.apply();
    }
    document.addEventListener('click', this.onClick, true);
    this.href = window.location.href;
    this.watch = setInterval(() => {
      if (window.location.href !== this.href) {
        this.href = window.location.href;
        this.apply();
      }
    }, 1000);
  }

  /** Güncel listeyi alır (SDK yapılandırması ve bölgesel kök belirlendikten sonra çağrılır). */
  async load(): Promise<void> {
    // Liste alınamasa da titreme önleme gizlemesi en geç burada kalkar.
    await this.refresh().finally(() => this.reveal());
  }

  private proof(): Record<string, string> {
    const sub = this.deps.subscriptionId();
    const hash = sub ? this.deps.ownershipHash(sub) : null;
    return sub && hash && /^[0-9a-f]{64}$/.test(hash) ? { subscription_id: sub, token_hash: hash } : {};
  }

  async refresh(): Promise<void> {
    const api = this.deps.api();
    if (!api || !this.started) return;
    try {
      const res = await api.request<WebPersonalizationList>('GET', `/web-personalizations${queryString({ language: this.deps.language().split('-')[0], ...this.proof() })}`);
      // Beklenmeyen yanıt müşteri sitesinde hata fırlatmaz; değişiklik uygulanmaz.
      if (!res || !Array.isArray(res.data)) throw new Error('beklenmeyen yanıt');
      this.list = res;
      writeJson(() => window.localStorage, `${this.key}:list`, res);
      this.apply();
      this.maybeEditor();
    } catch (err) {
      this.deps.logger.warn('kişiselleştirme alınamadı', err);
    }
  }

  private reveal(): void {
    document.documentElement.classList.remove(ANTI_FLICKER_CLASS);
  }

  /** Sayfayı yeniden değerlendirir: önce tüm değişiklikler geri alınır, sonra uygun deneyimler uygulanır. */
  private apply(): void {
    this.revertAll();
    const list = this.list?.data ?? [];
    const path = window.location.pathname + window.location.search;
    const page = { path, href: window.location.href, utm: {}, visits: this.visits };
    const session = readJson<{ utm?: Record<string, string> }>(() => window.sessionStorage, `pushizo:wc:${this.deps.appId() ?? ''}`);
    page.utm = session?.utm ?? {};
    this.active = eligiblePersonalizations(list, page, deviceKind(navigator.userAgent, window.innerWidth), Date.now()).map((p) => ({ p, ...resolvePersonalization(p, this.visitorId) }));
    this.applyActive();
    for (const a of this.active) this.expose(a.p.id, a.variantId);
    // Sayfa hedefi: daha önce maruz kalınmış deneyimin hedef sayfası.
    for (const p of list) if (pageGoalMatches(p.goal, path, window.location.href)) this.convert(p.id);
    if (this.active.length && !this.observer && typeof MutationObserver !== 'undefined') {
      let queued = false;
      this.observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          this.applyActive();
        });
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    this.reveal();
  }

  private applyActive(): void {
    for (const a of this.active)
      a.changes.forEach((c, i) => {
        let nodes: NodeListOf<Element>;
        try {
          nodes = document.querySelectorAll(c.selector);
        } catch {
          return; // geçersiz seçici yalnız bu değişikliği atlar
        }
        const tag = `${a.p.id}:${i}`;
        nodes.forEach((el) => {
          const done = this.touched.get(el) ?? new Set<string>();
          if (done.has(tag)) return;
          done.add(tag);
          this.touched.set(el, done);
          this.change(el, c);
        });
      });
  }

  private remember(el: Element, o: Original): void {
    const cur = this.originals.get(el) ?? {};
    if (o.text !== undefined && cur.text === undefined) cur.text = o.text;
    if (o.display && !cur.display) cur.display = o.display;
    for (const [k, v] of Object.entries(o.attrs ?? {})) if (!cur.attrs || !(k in cur.attrs)) cur.attrs = { ...cur.attrs, [k]: v };
    this.originals.set(el, cur);
  }

  private setAttrs(el: Element, values: Record<string, string | null>): void {
    this.remember(el, { attrs: Object.fromEntries(Object.keys(values).map((k) => [k, el.getAttribute(k)])) });
    for (const [k, v] of Object.entries(values)) {
      if (v === null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  }

  private change(el: Element, c: PersonalizationChange): void {
    const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
    if (c.action === 'text' && c.text !== null) {
      this.remember(el, { text: el.textContent });
      el.textContent = c.text;
    } else if (c.action === 'image' && el.tagName === 'IMG') {
      const url = safeUrl(c.url);
      if (url) this.setAttrs(el, { src: url, srcset: null, ...(c.alt !== null ? { alt: c.alt } : {}) });
    } else if (c.action === 'link' && el.tagName === 'A') {
      const url = safeUrl(c.url);
      if (!url) return;
      this.setAttrs(el, { href: url, ...(c.new_tab ? { target: '_blank', rel: 'noopener noreferrer' } : {}) });
      if (c.text) {
        this.remember(el, { text: el.textContent });
        el.textContent = c.text;
      }
    } else if ((c.action === 'hide' || c.action === 'show') && style) {
      this.remember(el, { display: [style.getPropertyValue('display'), style.getPropertyPriority('display')] });
      if (c.action === 'hide') style.setProperty('display', 'none', 'important');
      else {
        style.removeProperty('display');
        if (getComputedStyle(el).display === 'none') style.setProperty('display', 'block', 'important');
      }
    }
  }

  private revertAll(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const [el, o] of this.originals) {
      if (o.text !== undefined) el.textContent = o.text;
      for (const [k, v] of Object.entries(o.attrs ?? {})) {
        if (v === null) el.removeAttribute(k);
        else el.setAttribute(k, v);
      }
      const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
      if (o.display && style) {
        if (o.display[0]) style.setProperty('display', o.display[0], o.display[1]);
        else style.removeProperty('display');
      }
    }
    this.originals.clear();
    this.touched.clear();
    this.active = [];
  }

  private persist(): void {
    writeJson(() => window.localStorage, this.key, this.state);
    writeJson(() => window.sessionStorage, this.key, [...this.seen]);
  }

  /** Maruz kalma: oturum başına bir kez raporlanır; dönüşüm için ziyaretçi durumuna yazılır. */
  private expose(id: string, variantId: string | null): void {
    this.state.e[id] = variantId ?? '';
    if (!this.seen.has(id)) {
      this.seen.add(id);
      this.post(id, 'impression', variantId);
    }
    this.persist();
  }

  /** Dönüşüm: yalnız maruz kalmış ve hedefi olan deneyimde, ziyaretçi başına bir kez. */
  private convert(id: string): void {
    const p = this.list?.data.find((x) => x.id === id);
    if (!p?.goal || !(id in this.state.e) || this.state.v[id]) return;
    this.state.v[id] = 1;
    this.persist();
    this.post(id, 'conversion', this.state.e[id] || null);
  }

  /** SDK olayı (`Session.sendEvent`) olay hedeflerini değerlendirir. */
  onEvent(name: string): void {
    for (const p of this.list?.data ?? []) if (p.goal?.type === 'event' && p.goal.event === name) this.convert(p.id);
  }

  private readonly onClick = (e: Event): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    for (const p of this.list?.data ?? []) {
      if (p.goal?.type !== 'click') continue;
      try {
        if (target.closest(p.goal.selector)) this.convert(p.id);
      } catch {
        /* geçersiz seçici */
      }
    }
  };

  private post(id: string, type: 'impression' | 'conversion', variantId: string | null): void {
    const api = this.deps.api();
    if (!api) return;
    void api
      .request('POST', `/web-personalizations/${encodeURIComponent(id)}/events`, { type, visitor_id: this.visitorId, ...(variantId ? { variant_id: variantId } : {}), ...this.proof() })
      .catch((err: unknown) => this.deps.logger.debug('kişiselleştirme olayı gönderilemedi', err));
  }

  /** Görsel seçici (ADR-0083 §4): `?pushizo_editor=<nonce>` ile açılan pencerede ayrı paket yüklenir. */
  private maybeEditor(): void {
    const nonce = new URLSearchParams(window.location.search).get('pushizo_editor');
    const origins = this.list?.editor_origins ?? [];
    if (!nonce || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce) || !window.opener || !origins.length || document.getElementById('pushizo-editor')) return;
    const w = window as unknown as { __pushizoEditor?: { nonce: string; origins: string[] } };
    w.__pushizoEditor = { nonce, origins };
    const script = document.createElement('script');
    script.id = 'pushizo-editor';
    script.src = this.deps.editorUrl();
    script.async = true;
    script.crossOrigin = 'anonymous';
    document.head.appendChild(script);
  }

  destroy(): void {
    this.revertAll();
    if (this.watch) clearInterval(this.watch);
    if (typeof document !== 'undefined') document.removeEventListener('click', this.onClick, true);
    this.started = false;
  }
}
