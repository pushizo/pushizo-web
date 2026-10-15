import type { HtmlBridgeAction } from '../core/html-bridge.js';
import { safeColor, safeHttpUrl } from '../core/in-app-logic.js';
import type { InAppBlock, InAppMessage } from '../core/types.js';
import { renderHtmlFrame, type HtmlFrame } from './in-app-html.js';

export type InAppButtonBlock = Extract<InAppBlock, { type: 'button' }>;
type CarouselBlock = Extract<InAppBlock, { type: 'carousel' }>;

/** HTML in-app köprüsünden gelen (doğrulanmış) eylem; `close` kullanıcı kapatması olarak `onDismiss`'e gider. */
export type InAppBridgeAction = Exclude<HtmlBridgeAction, { type: 'ready' | 'resize' | 'close' }>;

export interface InAppRenderOptions {
  /** Kapat düğmesi ve varsayılan etiket dili. */
  language: string;
  /** Düğmeye tıklandı (aksiyonu yönetici uygular ve mesajı kapatır). */
  onButton: (button: InAppButtonBlock) => void;
  /** Kullanıcı kapattı: ×, Esc veya arka plana tıklama. */
  onDismiss: () => void;
  /** Banner `auto_dismiss_seconds` doldu. */
  onAutoDismiss: () => void;
  /** HTML in-app köprü eylemi (tıklama, tag, olay). */
  onBridge?: (action: InAppBridgeAction) => void;
  /** Testler için belge. */
  doc?: Document;
}

export interface RenderedInApp {
  /** Shadow DOM'u barındıran öğe (`#hs-in-app`). */
  host: HTMLElement;
  /** DOM'dan kaldırır, dinleyicileri temizler ve odağı önceki öğeye geri verir (tekrar çağrılabilir). */
  close: () => void;
}

const TEXTS = {
  tr: { close: 'Kapat', message: 'Mesaj', carousel: 'Kartlar', previous: 'Önceki kart', next: 'Sonraki kart', slide: (n: number, total: number) => `Kart ${n}/${total}` },
  en: { close: 'Close', message: 'Message', carousel: 'Cards', previous: 'Previous card', next: 'Next card', slide: (n: number, total: number) => `Card ${n} of ${total}` },
};
type Texts = (typeof TEXTS)['tr'];

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])';

// Stil Shadow DOM içinde izoledir; sayfa CSS'i mesajı, mesaj CSS'i sayfayı etkilemez.
const CSS = `
:host{all:initial}
.hs-layer{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:light dark}
.hs-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;animation:hs-fade .2s ease}
.hs-card{position:relative;box-sizing:border-box;background:var(--hs-bg,#ffffff);color:var(--hs-fg,#18181b);text-align:left}
.hs-card:focus{outline:none}
.hs-modal{width:100%;max-width:420px;max-height:calc(100vh - 32px);overflow:auto;border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.hs-fullscreen{position:fixed;inset:0;z-index:2147483000;overflow:auto;padding:48px 24px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;animation:hs-fade .2s ease}
.hs-fullscreen>.hs-content{width:100%;max-width:560px}
.hs-banner{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483000;width:calc(100% - 32px);max-width:640px;border-radius:12px;padding:12px 48px 12px 16px;box-shadow:0 10px 30px rgba(0,0,0,.2);animation:hs-fade .2s ease}
.hs-banner.hs-top{top:16px}.hs-banner.hs-bottom{bottom:16px}
.hs-banner>.hs-content{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;min-width:0}
.hs-image{display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto 12px}
.hs-banner .hs-image{width:48px;height:48px;object-fit:cover;margin:0}
.hs-title{margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:700;color:inherit}
.hs-banner .hs-title{font-size:16px;margin:0;flex:1 1 60%}
.hs-body{margin:0 0 16px;white-space:pre-line;opacity:.9;overflow-wrap:anywhere}
.hs-banner .hs-body{margin:0;flex:1 1 200px}
.hs-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.hs-fullscreen .hs-actions{justify-content:center}
.hs-modal .hs-actions .hs-button{flex:1 1 auto}
.hs-banner .hs-actions{margin:0}
.hs-button{background:var(--hs-btn-bg,#2563eb);color:var(--hs-btn-fg,#ffffff);border:0;border-radius:8px;padding:10px 16px;min-height:44px;font:inherit;font-weight:600;cursor:pointer}
.hs-button:hover{filter:brightness(1.08)}
.hs-close{position:absolute;top:6px;right:6px;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:inherit;font:400 26px/1 system-ui,sans-serif;cursor:pointer;opacity:.75}
.hs-close:hover{opacity:1;background:rgba(127,127,127,.18)}
.hs-button:focus-visible,.hs-close:focus-visible,.hs-nav:focus-visible,.hs-track:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
.hs-carousel{position:relative;margin:0 0 12px}
.hs-track{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;padding:2px 2px 8px;-webkit-overflow-scrolling:touch}
.hs-slide{flex:0 0 85%;scroll-snap-align:start;box-sizing:border-box;border:1px solid rgba(127,127,127,.25);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.hs-slide img{display:block;width:100%;height:140px;object-fit:cover;border-radius:8px}
.hs-slide h3{margin:0;font-size:16px;line-height:1.3}
.hs-slide p{margin:0;opacity:.9;white-space:pre-line;overflow-wrap:anywhere}
.hs-slide .hs-button{margin-top:auto}
.hs-carousel-nav{display:flex;justify-content:flex-end;gap:8px}
.hs-nav{width:44px;height:44px;border:1px solid rgba(127,127,127,.35);border-radius:50%;background:transparent;color:inherit;font:400 20px/1 system-ui,sans-serif;cursor:pointer}
.hs-html{padding:0;overflow:hidden}
.hs-html .hs-close{z-index:1;background:rgba(127,127,127,.25)}
.hs-html-frame{display:block;width:100%;border:0;background:transparent}
.hs-fullscreen.hs-html{padding:0;display:block}
.hs-fullscreen.hs-html .hs-html-frame{height:100vh}
.hs-banner.hs-html{padding:0}
@media (prefers-reduced-motion:reduce){.hs-track{scroll-behavior:auto}}
@media (prefers-color-scheme:dark){.hs-card{background:var(--hs-bg,#1f2227);color:var(--hs-fg,#f3f4f6)}}
@media (prefers-reduced-motion:reduce){.hs-backdrop,.hs-fullscreen,.hs-banner{animation:none}}
@keyframes hs-fade{from{opacity:0}to{opacity:1}}
`;

let sequence = 0;

function cardClass(layout: InAppMessage['display']['layout']): string {
  if (layout === 'modal') return 'hs-card hs-modal';
  if (layout === 'fullscreen') return 'hs-card hs-fullscreen';
  return `hs-card hs-banner ${layout === 'banner_top' ? 'hs-top' : 'hs-bottom'}`;
}

/**
 * In-app mesajını Shadow DOM içinde çizer. Metinler yalnızca `textContent` ile yazılır (HTML yorumlanmaz).
 * Modal/tam ekran: `role="dialog"` + `aria-modal="true"`, odak tuzağı, kapatınca odak geri verilir.
 * Banner'lar sayfayı engellemez (`aria-modal="false"`, odak çalınmaz).
 */
export function renderInAppMessage(
  message: InAppMessage,
  options: InAppRenderOptions,
): RenderedInApp {
  const doc = options.doc ?? document;
  const t = options.language.toLowerCase().startsWith('tr') ? TEXTS.tr : TEXTS.en;
  const { display } = message;
  const isBlocking = display.layout === 'modal' || display.layout === 'fullscreen';
  const uid = `hs-iam-${++sequence}`;

  const host = doc.createElement('div');
  host.id = 'hs-in-app';
  host.setAttribute('data-hs-message-id', message.id);
  host.setAttribute('data-hs-layout', display.layout);
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const layer = doc.createElement('div');
  layer.className = 'hs-layer';
  root.appendChild(layer);

  const card = doc.createElement('div');
  card.className = cardClass(display.layout);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', isBlocking ? 'true' : 'false');
  card.tabIndex = -1;
  const bg = safeColor(display.background_color);
  const fg = safeColor(display.text_color);
  if (bg) card.style.setProperty('--hs-bg', bg);
  if (fg) card.style.setProperty('--hs-fg', fg);

  const content = doc.createElement('div');
  content.className = 'hs-content';
  card.appendChild(content);

  // HTML içerik (ADR-0027): sandbox'lı iframe; köprü eylemleri yöneticiye iletilir.
  let frame: HtmlFrame | null = null;
  const isHtml = display.content_type === 'html' && typeof display.html === 'string';
  if (isHtml) {
    card.classList.add('hs-html');
    const height = display.layout === 'fullscreen' ? null : (display.html_height ?? (display.layout === 'modal' ? 360 : 120));
    frame = renderHtmlFrame({
      html: display.html as string,
      language: options.language,
      title: t.message,
      height,
      doc,
      onAction: (action) => {
        if (action.type === 'close') options.onDismiss();
        else options.onBridge?.(action);
      },
      // İçerik kendi içinde gezinemez: dış sayfaya gitmeye çalışırsa mesaj kapanır.
      onNavigationAttempt: () => options.onDismiss(),
    });
    content.appendChild(frame.iframe);
  }

  // Ardışık düğme blokları tek eylem satırında toplanır; blok sırası korunur.
  let actions: HTMLDivElement | null = null;
  let labelled = false;
  let described = false;
  for (const block of isHtml ? [] : display.blocks) {
    if (block.type !== 'button') actions = null;
    switch (block.type) {
      case 'image': {
        const src = safeHttpUrl(block.url);
        if (!src) break;
        const img = doc.createElement('img');
        img.className = 'hs-image';
        img.src = src;
        img.alt = block.alt ?? '';
        content.appendChild(img);
        break;
      }
      case 'title': {
        const h2 = doc.createElement('h2');
        h2.className = 'hs-title';
        h2.textContent = block.text;
        if (!labelled) {
          h2.id = `${uid}-title`;
          card.setAttribute('aria-labelledby', h2.id);
          labelled = true;
        }
        content.appendChild(h2);
        break;
      }
      case 'body': {
        const p = doc.createElement('p');
        p.className = 'hs-body';
        p.textContent = block.text;
        if (!described) {
          p.id = `${uid}-body`;
          card.setAttribute('aria-describedby', p.id);
          described = true;
        }
        content.appendChild(p);
        break;
      }
      case 'button': {
        if (!actions) {
          actions = doc.createElement('div');
          actions.className = 'hs-actions';
          content.appendChild(actions);
        }
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'hs-button';
        button.textContent = block.text;
        button.setAttribute('data-hs-button-id', block.id);
        const btnBg = safeColor(block.background_color);
        const btnFg = safeColor(block.text_color);
        if (btnBg) button.style.setProperty('--hs-btn-bg', btnBg);
        if (btnFg) button.style.setProperty('--hs-btn-fg', btnFg);
        button.addEventListener('click', () => options.onButton(block));
        actions.appendChild(button);
        break;
      }
      case 'carousel':
        content.appendChild(renderCarousel(doc, block, t, `${uid}-${block.id}`, options));
        break;
    }
  }
  if (!labelled) card.setAttribute('aria-label', t.message);

  if (display.dismissible) {
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'hs-close';
    close.setAttribute('aria-label', t.close);
    close.textContent = '×';
    close.addEventListener('click', () => options.onDismiss());
    card.appendChild(close);
  }

  if (display.layout === 'modal') {
    const backdrop = doc.createElement('div');
    backdrop.className = 'hs-backdrop';
    backdrop.appendChild(card);
    if (display.dismissible)
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) options.onDismiss();
      });
    layer.appendChild(backdrop);
  } else {
    layer.appendChild(card);
  }

  const focusables = (): HTMLElement[] => Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!host.isConnected) return;
    // Banner sayfayı engellemez: Esc yalnızca odak banner içindeyken kapatır.
    if (
      e.key === 'Escape' &&
      display.dismissible &&
      (isBlocking || e.composedPath().includes(host))
    ) {
      e.preventDefault();
      options.onDismiss();
      return;
    }
    if (e.key !== 'Tab' || !isBlocking) return;
    // Odak tuzağı: Tab/Shift+Tab mesajın içinde döner.
    const items = focusables();
    if (items.length === 0) {
      e.preventDefault();
      card.focus();
      return;
    }
    const active = root.activeElement;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const inside = active !== null && card.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  // Odak modal dışına kaçarsa (ör. sayfadaki bir öğeye tıklama) mesaja geri alınır.
  const onFocusIn = (e: FocusEvent): void => {
    if (host.isConnected && !e.composedPath().includes(host)) (focusables()[0] ?? card).focus();
  };

  const active = doc.activeElement;
  const previous =
    active && 'focus' in active && active !== doc.body ? (active as HTMLElement) : null;
  doc.addEventListener('keydown', onKeyDown, true);
  doc.body.appendChild(host);

  if (isBlocking) {
    // İlk eylem düğmesi (HTML'de iframe), yoksa kapat düğmesi, o da yoksa diyalog odaklanır.
    const target = card.querySelector<HTMLElement>('.hs-button, .hs-html-frame') ?? focusables()[0] ?? card;
    target.focus();
    doc.addEventListener('focusin', onFocusIn);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (!isBlocking && display.auto_dismiss_seconds && display.auto_dismiss_seconds > 0)
    timer = setTimeout(() => options.onAutoDismiss(), display.auto_dismiss_seconds * 1000);

  let closed = false;
  return {
    host,
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      frame?.destroy();
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('focusin', onFocusIn);
      host.remove();
      if (isBlocking && previous?.isConnected) previous.focus();
    },
  };
}

/**
 * Carousel: yatay kaydırmalı (scroll-snap) kartlar; ok düğmeleri ve klavye (←/→) ile gezinme. Her kart
 * `role="group"` + `aria-roledescription="slide"` ve "Kart n/N" etiketi taşır. Metinler yalnızca `textContent`.
 */
function renderCarousel(doc: Document, block: CarouselBlock, t: Texts, uid: string, options: InAppRenderOptions): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'hs-carousel';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-roledescription', 'carousel');
  root.setAttribute('aria-label', t.carousel);
  const track = doc.createElement('div');
  track.className = 'hs-track';
  track.id = `${uid}-track`;
  track.tabIndex = 0;
  root.appendChild(track);
  const cards = Array.isArray(block.cards) ? block.cards : [];
  cards.forEach((card, i) => {
    const slide = doc.createElement('div');
    slide.className = 'hs-slide';
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', t.slide(i + 1, cards.length));
    slide.setAttribute('data-hs-card-id', card.id);
    const src = safeHttpUrl(card.image_url);
    if (src) {
      const img = doc.createElement('img');
      img.src = src;
      img.alt = card.image_alt ?? '';
      img.loading = 'lazy';
      slide.appendChild(img);
    }
    const h3 = doc.createElement('h3');
    h3.textContent = card.title;
    slide.appendChild(h3);
    if (card.body) {
      const p = doc.createElement('p');
      p.textContent = card.body;
      slide.appendChild(p);
    }
    if (card.button) {
      const b = card.button;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'hs-button';
      button.textContent = b.text;
      button.setAttribute('data-hs-button-id', b.id);
      button.addEventListener('click', () =>
        options.onButton({ type: 'button', id: b.id, text: b.text, action: b.action, background_color: null, text_color: null }),
      );
      slide.appendChild(button);
    }
    track.appendChild(slide);
  });
  const scrollStep = (dir: 1 | -1): void => {
    const first = track.firstElementChild as HTMLElement | null;
    const step = (first?.offsetWidth ?? track.clientWidth) + 12;
    if (typeof track.scrollBy === 'function') track.scrollBy({ left: dir * step, behavior: 'smooth' });
    else track.scrollLeft += dir * step;
  };
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      scrollStep(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      scrollStep(-1);
    }
  });
  if (cards.length > 1) {
    const nav = doc.createElement('div');
    nav.className = 'hs-carousel-nav';
    const buttons: [1 | -1, string, string][] = [
      [-1, t.previous, '\u2039'],
      [1, t.next, '\u203a'],
    ];
    for (const [dir, label, glyph] of buttons) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'hs-nav';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-controls', track.id);
      btn.textContent = glyph;
      btn.addEventListener('click', () => scrollStep(dir));
      nav.appendChild(btn);
    }
    root.appendChild(nav);
  }
  return root;
}
