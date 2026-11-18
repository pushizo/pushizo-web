import { buildSelector } from '../core/selector.js';

/**
 * Görsel seçici arayüzü (ADR-0083 §4): imleç altındaki öğe vurgulanır, tıklanan öğenin seçicisi yalnız
 * `window.opener`'a ve yalnız güvenilen panel kökenlerine gönderilir. Sayfa metni gönderilmez. Esc ile kapanır.
 */
export function startVisualEditor(opts: { nonce: string; origins: string[] }): () => void {
  const tr = (navigator.language || 'en').toLowerCase().startsWith('tr');
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #6366f1;background:rgba(99,102,241,.12);border-radius:3px;transition:all .05s;display:none';
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#18181b;color:#fafafa;font:14px/1.4 system-ui,sans-serif;padding:8px 12px;text-align:center';
  bar.textContent = tr ? 'Pushizo öğe seçici: değiştirmek istediğiniz öğeye tıklayın (Esc ile çıkın).' : 'Pushizo element picker: click the element you want to change (Esc to exit).';
  document.body.append(box, bar);

  const ignored = (el: Element) => el === bar || el === box;
  const onMove = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || ignored(el)) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const onClick = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || ignored(el)) return;
    e.preventDefault();
    e.stopPropagation();
    const selector = buildSelector(el);
    if (!selector) {
      // Kesilmiş ya da tekil olmayan seçici yanlış öğeyi değiştirebilir: panele hiçbir şey gönderilmez.
      bar.textContent = tr
        ? 'Bu öğe için tekil bir seçici bulunamadı; öğeye bir kimlik (id) ya da data-pushizo özniteliği ekleyin.'
        : 'No unique selector for this element; add an id or a data-pushizo attribute to it.';
      return;
    }
    const message = { type: 'pushizo:selector', nonce: opts.nonce, selector, tag: el.tagName.toLowerCase() };
    // Mesaj yalnız eşleşen kökene ulaşır; diğer hedef kökenler tarayıcıda sessizce düşer.
    for (const origin of opts.origins) {
      try {
        (window.opener as Window | null)?.postMessage(message, origin);
      } catch {
        /* geçersiz köken */
      }
    }
    bar.textContent = tr ? `Seçildi: ${message.selector} — panele gönderildi.` : `Selected: ${message.selector} — sent to the dashboard.`;
  };
  const stop = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
    bar.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  return stop;
}
