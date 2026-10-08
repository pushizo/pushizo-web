import type { CustomLinkOptions } from '../core/types.js';
import { safeAccentColor } from './prompts.js';

/** Sayfada düğmenin render edileceği kapsayıcılar (eski sağlayıcı `eski sağlayıcı-customlink-container` karşılığı). */
export const CUSTOMLINK_SELECTOR = '.herosignal-customlink-container';

const TEXTS = {
  tr: {
    subscribe: 'Bildirimlere abone ol',
    unsubscribe: 'Bildirim aboneliğinden çık',
    explanation: 'Sizin için önemli gelişmelerden anında haberdar olun.',
  },
  en: {
    subscribe: 'Subscribe to push notifications',
    unsubscribe: 'Unsubscribe from push notifications',
    explanation: 'Get updates on all sorts of things that matter to you.',
  },
};

const STYLE_ID = 'hs-customlink-style';
const CSS = `
.hs-customlink{display:flex;flex-direction:column;align-items:flex-start;gap:8px;font:inherit}
.hs-customlink p{margin:0;opacity:.85}
.hs-customlink button{border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;background:#2563eb;color:#fff}
.hs-customlink button:disabled{opacity:.6;cursor:progress}
.hs-customlink button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.hs-customlink .hs-small{padding:4px 10px;font-size:12px}
.hs-customlink .hs-medium{padding:8px 14px;font-size:14px}
.hs-customlink .hs-large{padding:12px 20px;font-size:16px}
.hs-customlink .hs-link{background:none;color:#2563eb;padding:0;text-decoration:underline}
@media (prefers-color-scheme:dark){.hs-customlink .hs-link{color:#60a5fa}}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export interface CustomLinkState {
  subscribed: boolean;
  busy: boolean;
}

/**
 * Kapsayıcıyı (yoksa) hazırlar ve geçerli abonelik durumuna göre günceller. Metinler `textContent` ile yazılır
 * (XSS'e karşı), renkler yalnızca #rrggbb kabul edilir. Abone iken `unsubscribeEnabled: false` ise düğme gizlenir.
 */
export function renderCustomLink(
  container: Element,
  options: CustomLinkOptions,
  language: string,
  state: CustomLinkState,
  onClick: () => void,
): void {
  ensureStyle();
  const t = language.toLowerCase().startsWith('tr') ? TEXTS.tr : TEXTS.en;
  let root = Array.from(container.children).find((c): c is HTMLElement => c.classList.contains('hs-customlink'));
  if (!root) {
    root = document.createElement('div');
    root.className = 'hs-customlink';
    const explanation = document.createElement('p');
    explanation.className = 'hs-customlink-explanation';
    const button = document.createElement('button');
    button.type = 'button';
    const style = options.style === 'link' ? 'hs-link' : 'hs-button';
    const size = options.size === 'small' || options.size === 'large' ? options.size : 'medium';
    button.className = `hs-customlink-button ${style} hs-${size}`;
    const background = safeAccentColor(options.color?.button);
    const color = safeAccentColor(options.color?.text);
    if (options.style === 'link') {
      // Bağlantı görünümünde metin rengi düğme renginden gelir (eski sağlayıcı davranışı).
      if (background) button.style.color = background;
    } else {
      if (background) button.style.background = background;
      if (color) button.style.color = color;
    }
    button.addEventListener('click', onClick);
    root.append(explanation, button);
    container.appendChild(root);
  }
  const explanation = root.querySelector<HTMLElement>('.hs-customlink-explanation')!;
  const button = root.querySelector<HTMLButtonElement>('.hs-customlink-button')!;
  const explanationText = options.text?.explanation ?? t.explanation;
  explanation.textContent = explanationText;
  explanation.hidden = !explanationText;
  const label = state.subscribed ? (options.text?.unsubscribe ?? t.unsubscribe) : (options.text?.subscribe ?? t.subscribe);
  button.textContent = label;
  button.setAttribute('aria-pressed', String(state.subscribed));
  button.hidden = state.subscribed && options.unsubscribeEnabled === false;
  button.disabled = state.busy;
  if (state.busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}
