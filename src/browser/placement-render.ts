import { safeColor, safeHttpUrl } from '../core/in-app-logic.js';
import type { InAppBlock, InAppMessage } from '../core/types.js';

type ButtonBlock = Extract<InAppBlock, { type: 'button' }>;

const CSS = `
:host{display:block}
.hs-placement{box-sizing:border-box;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--hs-fg,inherit);background:var(--hs-bg,transparent);border-radius:12px;padding:16px;position:relative;overflow-wrap:anywhere;color-scheme:light dark}
.hs-placement.hs-filled{border:0}
.hs-placement:not(.hs-filled){border:1px solid rgba(127,127,127,.3)}
.hs-image{display:block;width:100%;height:auto;max-height:280px;object-fit:cover;border-radius:8px;margin:0 0 12px}
.hs-title{margin:0 0 6px;font-size:17px;line-height:1.3;padding-right:32px}
.hs-body{margin:0 0 12px;white-space:pre-line;opacity:.9}
.hs-actions{display:flex;flex-wrap:wrap;gap:8px}
.hs-button{background:var(--hs-btn-bg,#2563eb);color:var(--hs-btn-fg,#fff);border:0;border-radius:8px;padding:10px 16px;min-height:44px;font:inherit;font-weight:600;cursor:pointer}
.hs-button:hover{filter:brightness(1.08)}
.hs-close{position:absolute;top:6px;right:6px;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:inherit;font-size:20px;line-height:1;cursor:pointer;opacity:.7}
.hs-close:hover{opacity:1;background:rgba(127,127,127,.18)}
.hs-button:focus-visible,.hs-close:focus-visible{outline:2px solid currentColor;outline-offset:2px}
`;

export interface PlacementRenderOptions {
  language: string;
  doc?: Document;
  onButton: (button: ButtonBlock) => void;
  onDismiss: () => void;
}

/**
 * Yerleşim içeriğini verilen öğeye çizer (ADR-0068 §4). Shadow DOM sayfanın CSS'iyle çakışmayı önler; metin yalnızca `textContent` ile yazılır, görsel adresi
 * güvenli şemayla denetlenir. Sayfayı engellemez: odak almaz, katman açmaz.
 */
export function renderPlacement(message: InAppMessage, target: Element, options: PlacementRenderOptions): { remove: () => void } {
  const doc = options.doc ?? document;
  const host = doc.createElement('div');
  host.setAttribute('data-hs-placement-message', message.id);
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const { display } = message;
  const card = doc.createElement('div');
  card.className = 'hs-placement';
  const bg = safeColor(display.background_color);
  const fg = safeColor(display.text_color);
  if (bg) {
    card.style.setProperty('--hs-bg', bg);
    card.classList.add('hs-filled');
  }
  if (fg) card.style.setProperty('--hs-fg', fg);

  let actions: HTMLDivElement | null = null;
  for (const block of display.blocks) {
    if (block.type !== 'button') actions = null;
    if (block.type === 'image') {
      const src = safeHttpUrl(block.url);
      if (!src) continue;
      const img = doc.createElement('img');
      img.className = 'hs-image';
      img.src = src;
      img.alt = block.alt ?? '';
      card.appendChild(img);
    } else if (block.type === 'title') {
      const h = doc.createElement('h3');
      h.className = 'hs-title';
      h.textContent = block.text;
      card.appendChild(h);
    } else if (block.type === 'body') {
      const p = doc.createElement('p');
      p.className = 'hs-body';
      p.textContent = block.text;
      card.appendChild(p);
    } else if (block.type === 'button') {
      if (!actions) {
        actions = doc.createElement('div');
        actions.className = 'hs-actions';
        card.appendChild(actions);
      }
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'hs-button';
      button.textContent = block.text;
      const btnBg = safeColor(block.background_color);
      const btnFg = safeColor(block.text_color);
      if (btnBg) button.style.setProperty('--hs-btn-bg', btnBg);
      if (btnFg) button.style.setProperty('--hs-btn-fg', btnFg);
      button.addEventListener('click', () => options.onButton(block));
      actions.appendChild(button);
    }
  }

  if (display.dismissible) {
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'hs-close';
    close.setAttribute('aria-label', options.language.toLowerCase().startsWith('tr') ? 'Kapat' : 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => options.onDismiss());
    card.appendChild(close);
  }

  root.appendChild(card);
  target.appendChild(host);
  return { remove: () => host.remove() };
}
