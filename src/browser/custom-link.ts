import type { CustomLinkOptions } from '../core/types.js';
import { safeAccentColor } from './prompts.js';

/** Özel bağlantı isteminin yerleştirileceği öğelerin sınıfı (eski sağlayıcı ile aynı adlandırma düzeni). */
export const CUSTOM_LINK_SELECTOR = '.herosignal-customlink-container';

const TEXTS = {
  tr: {
    subscribe: 'Bildirimlere abone ol',
    unsubscribe: 'Bildirim aboneliğinden çık',
    explanation: 'Önemli güncellemeleri ve kampanyaları anında alın.',
  },
  en: {
    subscribe: 'Subscribe to push notifications',
    unsubscribe: 'Unsubscribe from push notifications',
    explanation: 'Get important updates and offers instantly.',
  },
};

const STYLE_ID = 'hs-customlink-style';
const CSS = `
.hs-cl-explanation{margin:0 0 8px;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;opacity:.85}
.hs-cl-button{border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;font:600 14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:8px 14px}
.hs-cl-button.hs-cl-small{font-size:12px;padding:6px 10px}.hs-cl-button.hs-cl-large{font-size:16px;padding:12px 20px}
.hs-cl-link{border:0;background:none;padding:0;color:#2563eb;text-decoration:underline;cursor:pointer;font:inherit}
.hs-cl-link.hs-cl-small{font-size:12px}.hs-cl-link.hs-cl-large{font-size:16px}
.hs-cl-button:disabled,.hs-cl-link:disabled{opacity:.6;cursor:progress}
@media (prefers-color-scheme:dark){.hs-cl-link{color:#60a5fa}}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Sayfadaki `.herosignal-customlink-container` öğelerine abone ol / çık bağlantısını çizer.
 * Abone olunmuşsa ve `unsubscribeEnabled` kapalıysa kapsayıcı boş bırakılır. Metinler `textContent` ile yazılır
 * (HTML enjeksiyonu yok); renkler yalnızca `#rrggbb` biçiminde kabul edilir.
 * @returns Çizilen kapsayıcı sayısı.
 */
export function renderCustomLinks(
  options: CustomLinkOptions,
  language: string,
  subscribed: boolean,
  onClick: () => Promise<void>,
  root: ParentNode = document,
): number {
  const containers = Array.from(root.querySelectorAll<HTMLElement>(CUSTOM_LINK_SELECTOR));
  if (containers.length === 0) return 0;
  ensureStyle();
  const t = language.toLowerCase().startsWith('tr') ? TEXTS.tr : TEXTS.en;
  const hidden = subscribed && !options.unsubscribeEnabled;
  const style = options.style === 'link' ? 'link' : 'button';
  const size = options.size === 'small' || options.size === 'large' ? options.size : 'medium';
  for (const container of containers) {
    container.replaceChildren();
    container.dataset.subscribed = String(subscribed);
    if (hidden) continue;
    const explanation = options.text?.explanation ?? t.explanation;
    if (explanation) {
      const p = document.createElement('p');
      p.className = 'hs-cl-explanation';
      p.textContent = explanation;
      container.appendChild(p);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `hs-cl-${style} hs-cl-${size}`;
    button.textContent = subscribed
      ? (options.text?.unsubscribe ?? t.unsubscribe)
      : (options.text?.subscribe ?? t.subscribe);
    const background = safeAccentColor(options.color?.button);
    const text = safeAccentColor(options.color?.text);
    if (style === 'button' && background) button.style.background = background;
    if (text) button.style.color = text;
    button.addEventListener('click', () => {
      button.disabled = true;
      void onClick().finally(() => {
        button.disabled = false;
      });
    });
    container.appendChild(button);
  }
  return containers.length;
}
