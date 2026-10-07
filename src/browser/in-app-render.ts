import { safeColor, safeHttpUrl } from '../core/in-app-logic.js';
import type { InAppBlock, InAppMessage } from '../core/types.js';

export type InAppButtonBlock = Extract<InAppBlock, { type: 'button' }>;

export interface InAppRenderOptions {
  /** Kapat düğmesi ve varsayılan etiket dili. */
  language: string;
  /** Düğmeye tıklandı (aksiyonu yönetici uygular ve mesajı kapatır). */
  onButton: (button: InAppButtonBlock) => void;
  /** Kullanıcı kapattı: ×, Esc veya arka plana tıklama. */
  onDismiss: () => void;
  /** Banner `auto_dismiss_seconds` doldu. */
  onAutoDismiss: () => void;
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
  tr: { close: 'Kapat', message: 'Mesaj' },
  en: { close: 'Close', message: 'Message' },
};

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
.hs-button:focus-visible,.hs-close:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
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

  // Ardışık düğme blokları tek eylem satırında toplanır; blok sırası korunur.
  let actions: HTMLDivElement | null = null;
  let labelled = false;
  let described = false;
  for (const block of display.blocks) {
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
    // İlk eylem düğmesi, yoksa kapat düğmesi, o da yoksa diyalog odaklanır.
    const target = card.querySelector<HTMLElement>('.hs-button') ?? focusables()[0] ?? card;
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
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('focusin', onFocusIn);
      host.remove();
      if (isBlocking && previous?.isConnected) previous.focus();
    },
  };
}
