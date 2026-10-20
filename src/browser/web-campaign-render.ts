import { safeColor, safeHttpUrl } from '../core/in-app-logic.js';
import type { WebCampaignBlock, WebCampaignDisplay, WebForm, WebSurvey } from '../core/types.js';

/**
 * Web kampanyası çizimi (ADR-0039): Shadow DOM içinde güvenli DOM (metinler yalnızca `textContent`, satır içi betik
 * yok, stil `adoptedStyleSheets` ile — katı CSP'li sitelerde de çalışır; desteklenmiyorsa `<style>`). Pop-up ve tam
 * ekran `role="dialog"` + `aria-modal`, odak tuzağı, Esc ile kapatma ve kapanınca odağın geri verilmesi; banner ve
 * slide-in sayfayı engellemez. Form ve anket alanları etiketli, hatalar `aria-describedby` ve canlı bölgeyle duyurulur.
 */

export type ButtonBlock = Extract<WebCampaignBlock, { type: 'button' }>;
export interface SubmitOutcome {
  ok: boolean;
  message: string;
  /** Alan/soru → hata metni. */
  errors?: Record<string, string>;
}

export interface WebCampaignRenderOptions {
  language: string;
  form?: WebForm | null;
  survey?: WebSurvey | null;
  onButton: (b: ButtonBlock) => void;
  onClose: () => void;
  onAutoClose: () => void;
  onForm?: (values: Record<string, string | boolean>, elapsedMs: number) => Promise<SubmitOutcome>;
  onSurvey?: (answers: Record<string, number | string | string[]>) => Promise<SubmitOutcome>;
  doc?: Document;
}

export interface RenderedWebCampaign {
  host: HTMLElement;
  close: () => void;
}

const T = {
  tr: { close: 'Kapat', dialog: 'Kampanya', required: 'zorunlu', sending: 'Gönderiliyor…', error: 'Lütfen işaretli alanları kontrol edin.', choose: 'Seçin', low: 'Hiç olası değil', high: 'Çok olası', policy: 'Metni oku' },
  en: { close: 'Close', dialog: 'Campaign', required: 'required', sending: 'Sending…', error: 'Please check the highlighted fields.', choose: 'Choose', low: 'Not at all likely', high: 'Extremely likely', policy: 'Read the notice' },
};

const CSS = `:host{all:initial}
.w{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:light dark}
.bd{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.c{position:relative;box-sizing:border-box;background:var(--bg,#fff);color:var(--fg,#18181b);border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:100%;max-width:var(--mw,440px);max-height:calc(100vh - 32px);overflow:auto;text-align:left;animation:f .2s ease}
.c:focus{outline:none}
.fs{position:fixed;inset:0;z-index:2147483000;max-width:none;max-height:none;border-radius:0;display:flex;flex-direction:column;justify-content:center;align-items:center}
.fs>.in{width:100%;max-width:var(--mw,560px)}
.bn{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483000;width:calc(100% - 32px);max-width:var(--mw,720px);border-radius:12px;padding:14px 52px 14px 18px}
.top{top:16px}.bot{bottom:16px}
.si{position:fixed;bottom:16px;z-index:2147483000;width:calc(100% - 32px);max-width:var(--mw,380px)}
.l{left:16px}.r{right:16px}
img{display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto 12px}
h2{margin:0 0 8px;font-size:20px;line-height:1.3}
p{margin:0 0 12px;white-space:pre-line;overflow-wrap:anywhere}
.a{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.b{background:var(--bb,#2563eb);color:var(--bf,#fff);border:0;border-radius:8px;padding:10px 16px;min-height:44px;font:inherit;font-weight:600;cursor:pointer}
.x{position:absolute;top:6px;right:6px;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:inherit;font:400 26px/1 system-ui,sans-serif;cursor:pointer}
.x:hover{background:rgba(127,127,127,.18)}
form{display:grid;gap:12px;margin-top:8px}
fieldset{border:0;margin:0;padding:0;display:grid;gap:6px}
legend,label.t{font-weight:600;padding:0}
input[type=text],input[type=email],input[type=tel],select,textarea{font:inherit;box-sizing:border-box;width:100%;min-height:44px;padding:9px 12px;border:1px solid #a1a1aa;border-radius:8px;background:#fff;color:#18181b}
.ck{display:flex;gap:8px;align-items:flex-start}.ck input{width:20px;height:20px;margin:2px 0 0;flex:none}
.sc{display:flex;flex-wrap:wrap;gap:6px}
.sc label{position:relative}.sc input{position:absolute;opacity:0;inset:0;margin:0}
.sc span{display:inline-flex;align-items:center;justify-content:center;min-width:38px;min-height:44px;border:1px solid #a1a1aa;border-radius:8px;font-weight:600;cursor:pointer}
.sc input:checked+span{background:#2563eb;border-color:#2563eb;color:#fff}
.ends{display:flex;justify-content:space-between;font-size:13px;opacity:.8}
.e{color:#dc2626;font-size:14px;margin:0}
[aria-invalid=true]{border-color:#dc2626!important}
.st{font-weight:600;margin:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.b:focus-visible,.x:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.sc input:focus-visible+span,a:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
@media (prefers-color-scheme:dark){.c{background:var(--bg,#1f2227);color:var(--fg,#f3f4f6)}}
@media (prefers-reduced-motion:reduce){.c{animation:none}}
@keyframes f{from{opacity:0}to{opacity:1}}`;

const FOCUSABLE = 'button:not([disabled]),[href],input:not([tabindex="-1"]),select,textarea,[tabindex]:not([tabindex="-1"])';
let seq = 0;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function applyStyle(doc: Document, root: ShadowRoot): void {
  // Constructable stylesheet CSP `style-src` kapsamında değildir; eski tarayıcıda `<style>` yedeği.
  const Sheet = (doc.defaultView)?.CSSStyleSheet;
  try {
    if (Sheet && 'adoptedStyleSheets' in root) {
      const sheet = new Sheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    /* yedeğe geç */
  }
  root.appendChild(el(doc, 'style', undefined, CSS));
}

export function renderWebCampaign(display: WebCampaignDisplay, o: WebCampaignRenderOptions): RenderedWebCampaign {
  const doc = o.doc ?? document;
  const t = o.language.toLowerCase().startsWith('tr') ? T.tr : T.en;
  const uid = `hs-wc-${++seq}`;
  const blocking = display.layout === 'popup' || display.layout === 'fullscreen';
  const host = el(doc, 'div');
  host.id = uid;
  host.setAttribute('data-hs-web-campaign', display.layout);
  const root = host.attachShadow({ mode: 'open' });
  applyStyle(doc, root);
  const layer = el(doc, 'div', 'w');
  root.appendChild(layer);

  const card = el(doc, 'div', 'c');
  if (display.layout === 'fullscreen') card.classList.add('fs');
  else if (display.layout === 'banner_top' || display.layout === 'banner_bottom') card.classList.add('bn', display.layout === 'banner_top' ? 'top' : 'bot');
  else if (display.layout === 'slide_in') card.classList.add('si', display.position === 'left' ? 'l' : 'r');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', blocking ? 'true' : 'false');
  card.tabIndex = -1;
  const bg = safeColor(display.background_color);
  const fg = safeColor(display.text_color);
  if (bg) card.style.setProperty('--bg', bg);
  if (fg) card.style.setProperty('--fg', fg);
  if (display.max_width) card.style.setProperty('--mw', `${display.max_width}px`);
  const inner = el(doc, 'div', 'in');
  card.appendChild(inner);

  let labelled = false;
  let actions: HTMLDivElement | null = null;
  for (const b of display.blocks) {
    if (b.type !== 'button') actions = null;
    if (b.type === 'image') {
      const src = safeHttpUrl(b.url);
      if (!src) continue;
      const img = el(doc, 'img');
      img.src = src;
      img.alt = b.alt;
      inner.appendChild(img);
    } else if (b.type === 'title') {
      const h = el(doc, 'h2', undefined, b.text);
      if (!labelled) {
        h.id = `${uid}-t`;
        card.setAttribute('aria-labelledby', h.id);
        labelled = true;
      }
      inner.appendChild(h);
    } else if (b.type === 'body') {
      inner.appendChild(el(doc, 'p', undefined, b.text));
    } else {
      if (!actions) inner.appendChild((actions = el(doc, 'div', 'a')));
      const btn = el(doc, 'button', 'b', b.text);
      btn.type = 'button';
      btn.setAttribute('data-hs-button-id', b.id);
      const bb = safeColor(b.background_color);
      const bf = safeColor(b.text_color);
      if (bb) btn.style.setProperty('--bb', bb);
      if (bf) btn.style.setProperty('--bf', bf);
      btn.addEventListener('click', () => o.onButton(b));
      actions.appendChild(btn);
    }
  }
  if (!labelled) card.setAttribute('aria-label', t.dialog);
  if (o.form && o.onForm) inner.appendChild(formView(doc, o.form, t, uid, o.onForm));
  else if (o.survey && o.onSurvey) inner.appendChild(surveyView(doc, o.survey, t, uid, o.onSurvey));

  if (display.dismissible) {
    const x = el(doc, 'button', 'x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t.close);
    x.addEventListener('click', () => o.onClose());
    card.appendChild(x);
  }
  if (display.layout === 'popup') {
    const bd = el(doc, 'div', 'bd');
    bd.appendChild(card);
    if (display.dismissible) bd.addEventListener('click', (e) => e.target === bd && o.onClose());
    layer.appendChild(bd);
  } else layer.appendChild(card);

  const items = () => Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
  const onKey = (e: KeyboardEvent) => {
    if (!host.isConnected) return;
    if (e.key === 'Escape' && display.dismissible && (blocking || e.composedPath().includes(host))) {
      e.preventDefault();
      o.onClose();
      return;
    }
    if (e.key !== 'Tab' || !blocking) return;
    const list = items();
    if (!list.length) {
      e.preventDefault();
      card.focus();
      return;
    }
    const active = root.activeElement;
    const inside = !!active && card.contains(active);
    if (e.shiftKey && (active === list[0] || !inside)) {
      e.preventDefault();
      list[list.length - 1]!.focus();
    } else if (!e.shiftKey && (active === list[list.length - 1] || !inside)) {
      e.preventDefault();
      list[0]!.focus();
    }
  };
  const onFocus = (e: FocusEvent) => {
    if (host.isConnected && !e.composedPath().includes(host)) (items()[0] ?? card).focus();
  };
  const prev = doc.activeElement && doc.activeElement !== doc.body ? (doc.activeElement as HTMLElement) : null;
  doc.addEventListener('keydown', onKey, true);
  doc.body.appendChild(host);
  if (blocking) {
    (card.querySelector<HTMLElement>('input,select,textarea,.b') ?? items()[0] ?? card).focus();
    doc.addEventListener('focusin', onFocus);
  }
  const timer = !blocking && display.auto_dismiss_seconds ? setTimeout(() => o.onAutoClose(), display.auto_dismiss_seconds * 1000) : null;
  let closed = false;
  return {
    host,
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', onFocus);
      host.remove();
      if (blocking && prev?.isConnected) prev.focus();
    },
  };
}

type Texts = (typeof T)['tr'];

/** Ortak form iskeleti: canlı durum bölgesi, gönderim düğmesi, hataların alanlara bağlanması. */
function shell(doc: Document, uid: string, label: string, submitLabel: string) {
  const form = el(doc, 'form');
  form.noValidate = true;
  form.setAttribute('aria-label', label);
  const status = el(doc, 'p', 'st');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.id = `${uid}-s`;
  const submit = el(doc, 'button', 'b', submitLabel);
  submit.type = 'submit';
  return { form, status, submit };
}

function markErrors(form: HTMLFormElement, uid: string, errors: Record<string, string> | undefined, doc: Document): void {
  for (const old of Array.from(form.querySelectorAll('.e'))) old.remove();
  for (const node of Array.from(form.querySelectorAll('[aria-invalid]'))) node.removeAttribute('aria-invalid');
  let first: HTMLElement | null = null;
  for (const [id, msg] of Object.entries(errors ?? {})) {
    const target = form.querySelector<HTMLElement>(`[data-f="${CSS_ESCAPE(id)}"]`);
    if (!target) continue;
    const p = el(doc, 'p', 'e', msg);
    p.id = `${uid}-e-${id}`;
    target.appendChild(p);
    const input = target.querySelector<HTMLElement>('input,select,textarea') ?? target;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', p.id);
    first ??= input;
  }
  first?.focus();
}

/** Başarı: form yerine durum metni kalır ve odak ona taşınır (ekran okuyucu duyurur, odak kaybolmaz). */
function done(form: HTMLFormElement, status: HTMLElement): void {
  form.replaceChildren(status);
  status.tabIndex = -1;
  status.focus();
}

const CSS_ESCAPE = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '');

function formView(doc: Document, f: WebForm, t: Texts, uid: string, submitFn: NonNullable<WebCampaignRenderOptions['onForm']>): HTMLElement {
  const { form, status, submit } = shell(doc, uid, t.dialog, f.submit_label);
  const opened = Date.now();
  for (const field of f.fields) {
    const id = `${uid}-${CSS_ESCAPE(field.id)}`;
    const wrap = el(doc, field.type === 'radio' ? 'fieldset' : 'div');
    wrap.setAttribute('data-f', field.id);
    const labelText = field.label + (field.required ? ' *' : '');
    if (field.type === 'checkbox' || field.type === 'consent') {
      wrap.className = 'ck';
      const input = el(doc, 'input');
      input.type = 'checkbox';
      input.id = id;
      input.name = field.id;
      input.required = field.required;
      const label = el(doc, 'label', undefined, labelText);
      label.htmlFor = id;
      wrap.append(input, label);
      const policy = safeHttpUrl(field.policy_url);
      if (policy) {
        const a = el(doc, 'a', undefined, t.policy);
        a.href = policy;
        a.target = '_blank';
        a.rel = 'noopener';
        wrap.appendChild(a);
      }
    } else if (field.type === 'radio') {
      wrap.appendChild(el(doc, 'legend', undefined, labelText));
      field.options.forEach((opt, i) => {
        const row = el(doc, 'div', 'ck');
        const input = el(doc, 'input');
        input.type = 'radio';
        input.name = field.id;
        input.value = opt.value;
        input.id = `${id}-${i}`;
        if (i === 0) input.required = field.required;
        const label = el(doc, 'label', undefined, opt.label);
        label.htmlFor = input.id;
        row.append(input, label);
        wrap.appendChild(row);
      });
    } else {
      const label = el(doc, 'label', 't', labelText);
      label.htmlFor = id;
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (field.type === 'select') {
        input = el(doc, 'select');
        input.appendChild(el(doc, 'option', undefined, t.choose)).value = '';
        for (const opt of field.options) input.appendChild(el(doc, 'option', undefined, opt.label)).value = opt.value;
      } else if (field.type === 'textarea') {
        input = el(doc, 'textarea');
        input.rows = 3;
      } else {
        input = el(doc, 'input');
        input.type = field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text';
        const auto = { email: 'email', phone: 'tel', first_name: 'given-name', last_name: 'family-name', full_name: 'name' } as Record<string, string>;
        if (auto[field.type]) input.autocomplete = auto[field.type] as AutoFill;
      }
      input.id = id;
      input.name = field.id;
      input.required = field.required;
      if (field.placeholder && 'placeholder' in input) input.placeholder = field.placeholder;
      if (field.max_length && 'maxLength' in input) input.maxLength = field.max_length;
      wrap.append(label, input);
    }
    form.appendChild(wrap);
  }
  // Bal küpü: ekran okuyucu ve klavyeden gizli.
  const hp = el(doc, 'input');
  hp.type = 'text';
  hp.name = 'website';
  hp.tabIndex = -1;
  hp.autocomplete = 'off';
  hp.setAttribute('aria-hidden', 'true');
  hp.className = 'sr';
  form.append(hp, submit, status);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (hp.value) {
      status.textContent = f.success_message;
      done(form, status);
      return;
    }
    const values: Record<string, string | boolean> = {};
    for (const field of f.fields) {
      const nodes = form.querySelectorAll<HTMLInputElement>(`[name="${CSS_ESCAPE(field.id)}"]`);
      if (field.type === 'checkbox' || field.type === 'consent') values[field.id] = !!nodes[0]?.checked;
      else if (field.type === 'radio') {
        const c = Array.from(nodes).find((n) => n.checked);
        if (c) values[field.id] = c.value;
      } else if (nodes[0]?.value.trim()) values[field.id] = nodes[0].value.trim();
    }
    submit.disabled = true;
    status.textContent = t.sending;
    void submitFn(values, Date.now() - opened).then((r) => {
      submit.disabled = false;
      status.textContent = r.message || (r.ok ? '' : t.error);
      if (r.ok) done(form, status);
      else markErrors(form, uid, r.errors, doc);
    });
  });
  return form;
}

function surveyView(doc: Document, s: WebSurvey, t: Texts, uid: string, submitFn: NonNullable<WebCampaignRenderOptions['onSurvey']>): HTMLElement {
  const { form, status, submit } = shell(doc, uid, t.dialog, s.submit_label);
  s.questions.forEach((q, qi) => {
    const id = `${uid}-q${qi}`;
    const wrap = el(doc, q.type === 'text' ? 'div' : 'fieldset');
    wrap.setAttribute('data-f', q.id);
    const text = q.text + (q.required ? ' *' : '');
    if (q.type === 'text') {
      const label = el(doc, 'label', 't', text);
      label.htmlFor = id;
      const ta = el(doc, 'textarea');
      ta.id = id;
      ta.name = q.id;
      ta.rows = 3;
      ta.maxLength = 2000;
      ta.required = q.required;
      if (q.placeholder) ta.placeholder = q.placeholder;
      wrap.append(label, ta);
    } else {
      wrap.appendChild(el(doc, 'legend', undefined, text));
      const scale = q.type === 'nps' || q.type === 'csat';
      const box = el(doc, 'div', scale ? 'sc' : undefined);
      const opts = scale
        ? Array.from({ length: q.type === 'nps' ? 11 : 5 }, (_, i) => String(q.type === 'nps' ? i : i + 1)).map((v) => ({ value: v, label: v }))
        : q.options;
      opts.forEach((opt, i) => {
        const input = el(doc, 'input');
        input.type = q.type === 'multiple_choice' ? 'checkbox' : 'radio';
        input.name = q.id;
        input.value = opt.value;
        input.id = `${id}-${i}`;
        if (i === 0 && q.type !== 'multiple_choice') input.required = q.required;
        const label = el(doc, 'label');
        label.htmlFor = input.id;
        if (scale) {
          label.append(input, el(doc, 'span', undefined, opt.label));
          box.appendChild(label);
        } else {
          label.textContent = opt.label;
          const row = el(doc, 'div', 'ck');
          row.append(input, label);
          box.appendChild(row);
        }
      });
      wrap.appendChild(box);
      if (scale) {
        const ends = el(doc, 'div', 'ends');
        ends.setAttribute('aria-hidden', 'true');
        ends.append(el(doc, 'span', undefined, q.low_label ?? t.low), el(doc, 'span', undefined, q.high_label ?? t.high));
        wrap.appendChild(ends);
      }
    }
    form.appendChild(wrap);
  });
  form.append(submit, status);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const answers: Record<string, number | string | string[]> = {};
    for (const q of s.questions) {
      const nodes = Array.from(form.querySelectorAll<HTMLInputElement>(`[name="${CSS_ESCAPE(q.id)}"]`));
      if (q.type === 'text') {
        const v = nodes[0]?.value.trim();
        if (v) answers[q.id] = v;
      } else {
        const checked = nodes.filter((n) => n.checked).map((n) => n.value);
        if (!checked.length) continue;
        answers[q.id] = q.type === 'multiple_choice' ? checked : q.type === 'single_choice' ? checked[0]! : Number(checked[0]);
      }
    }
    submit.disabled = true;
    status.textContent = t.sending;
    void submitFn(answers).then((r) => {
      submit.disabled = false;
      status.textContent = r.message || (r.ok ? '' : t.error);
      if (r.ok) done(form, status);
      else markErrors(form, uid, r.errors, doc);
    });
  });
  return form;
}
