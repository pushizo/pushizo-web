import type { ContentCardsMountOptions, ContentCardsSource, ContentCardsViewHandle } from '../core/content-cards.js';
import type { ContentCard } from '../core/types.js';

/**
 * Hazır içerik kartı akışı (ADR-0082): ayrı paket (`PushizoContentCards.js` / `@pushizo/web/content-cards`), ana SDK'ya
 * yük getirmez. Açık Shadow DOM ile sayfa stillerinden yalıtılır; metin yalnız `textContent` ile yazılır, bağlantı ve
 * görsel adresleri http(s) şemasıyla sınırlanır. Android `HsContentCardsView` / iOS `HSContentCardsView` ile aynı
 * davranış: yükleniyor, boş ve hata (yeniden dene) durumları; kartın en az yarısı görününce gösterim bir kez kaydedilir;
 * tıklama kaydedilir ve bağlantı açılır (`onCardClick` true dönerse site işler); × kartı kapatır.
 * Erişilebilirlik: akış adlandırılmış bölge + liste, durum `role="status"`, kapatınca odak komşu karta taşınır.
 */

export const CARDS_TEXT = {
  tr: {
    label: 'Kartlar',
    loading: 'Yükleniyor…',
    empty: 'Henüz kart yok',
    error: 'Kartlar yüklenemedi.',
    retry: 'Tekrar dene',
    dismiss: 'Kartı kapat',
    pinned: 'Sabitlendi',
  },
  en: {
    label: 'Cards',
    loading: 'Loading…',
    empty: 'No cards yet',
    error: 'Cards could not be loaded.',
    retry: 'Try again',
    dismiss: 'Dismiss card',
    pinned: 'Pinned',
  },
};
type Strings = (typeof CARDS_TEXT)['tr'];

type Part = 'image' | 'text' | 'button';

/**
 * Kart türüne göre gösterilecek parçalar (mobil SDK'larla aynı kural): klasik metin (+düğme), görselli kartta görsel
 * üstte; yalnız görsel kartta metin yoktur. Görseli olmayan görsel kartı metne düşer (boş kart gösterilmez).
 */
export function cardParts(card: Pick<ContentCard, 'type' | 'title' | 'body' | 'imageUrl' | 'buttonText'>): Part[] {
  const hasImage = !!card.imageUrl?.trim();
  const hasText = !!card.title?.trim() || !!card.body?.trim();
  const parts: Part[] = [];
  if (card.type !== 'classic' && hasImage) parts.push('image');
  if (card.type === 'classic' || !hasImage || (card.type === 'captioned_image' && hasText)) parts.push('text');
  if (parts.includes('text') && card.buttonText?.trim()) parts.push('button');
  return parts;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Yalnız http(s) adresi kabul edilir (`javascript:` vb. reddedilir). */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function styles(color: string, theme: 'light' | 'dark' | 'auto'): string {
  const dark = `--hs-bg:#1e1f24;--hs-fg:#f2f2f5;--hs-muted:#b4b6be;--hs-border:#2c2e35;--hs-accent:${color === '#2563eb' ? '#8ab4ff' : color};--hs-on:${color === '#2563eb' ? '#10131a' : '#fff'};`;
  const light = `--hs-bg:#ffffff;--hs-fg:#15171c;--hs-muted:#5b5f6b;--hs-border:#e3e5ea;--hs-accent:${color};--hs-on:#fff;`;
  return `
:host{all:initial;display:block;${theme === 'dark' ? dark : light}font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45;color:var(--hs-fg)}
${theme === 'auto' ? `@media (prefers-color-scheme: dark){:host{${dark}}}` : ''}
*{box-sizing:border-box}
[hidden]{display:none!important}
ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px}
.card{position:relative;background:var(--hs-bg);border:1px solid var(--hs-border);border-radius:12px;overflow:hidden;overflow-wrap:anywhere}
.link{display:block;color:inherit;text-decoration:none}
img{display:block;width:100%;height:auto;max-height:320px;object-fit:cover}
.text{padding:12px 16px 14px}
.pin{display:inline-block;font-size:12px;font-weight:600;color:var(--hs-accent);margin-bottom:4px}
h3{margin:0 0 4px;font-size:16px;line-height:1.3;padding-inline-end:36px}
p{margin:0;color:var(--hs-muted);white-space:pre-line}
.btn{display:inline-block;margin-top:10px;padding:9px 16px;min-height:40px;border-radius:8px;background:var(--hs-accent);color:var(--hs-on);font-weight:600;text-decoration:none}
button{font:inherit;cursor:pointer}
.close{position:absolute;top:6px;inset-inline-end:6px;width:36px;height:36px;border:0;border-radius:50%;background:rgba(127,127,127,.22);color:var(--hs-fg);font-size:20px;line-height:1}
.status{padding:24px;text-align:center;color:var(--hs-muted)}
.retry{display:block;margin:12px auto 0;padding:9px 16px;min-height:40px;border-radius:8px;border:1px solid var(--hs-border);background:var(--hs-bg);color:var(--hs-fg)}
a:focus-visible,button:focus-visible,section:focus-visible{outline:3px solid var(--hs-accent);outline-offset:2px}`;
}

/** Kart akışını `target` içine kurar ve yükler. Önceki kurulum (aynı hedefte) kaldırılır. */
export function mountContentCards(source: ContentCardsSource, target: Element, options: ContentCardsMountOptions): ContentCardsViewHandle {
  const lang = options.language.toLowerCase().startsWith('tr') ? 'tr' : 'en';
  const t: Strings = { ...CARDS_TEXT[lang], ...(options.strings as Partial<Strings> | undefined) };
  const color = options.color && /^#[0-9a-fA-F]{6}$/.test(options.color) ? options.color : '#2563eb';

  target.querySelectorAll(':scope > [data-pushizo-cards]').forEach((node) => node.remove());
  const host = el('div', { 'data-pushizo-cards': '', dir: options.dir, lang: options.language });
  const root = host.attachShadow({ mode: 'open' });
  root.appendChild(el('style', {}, styles(color, options.theme ?? 'auto')));
  const region = el('section', { 'aria-label': t.label, tabindex: '-1' });
  const status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const message = el('span', {}, t.loading);
  const retry = el('button', { type: 'button', class: 'retry', hidden: '' }, t.retry);
  status.append(message, retry);
  const list = el('ul', { role: 'list', hidden: '' });
  region.append(status, list);
  root.appendChild(region);
  target.appendChild(host);

  const impressed = new Set<string>();
  const nodes = new Map<Element, ContentCard>();
  let destroyed = false;
  let seq = 0;

  const impress = (card: ContentCard) => {
    if (card.viewed || impressed.has(card.id)) return;
    impressed.add(card.id);
    // Gösterim en iyi çabadır: hata akışı bozmaz, sonraki yüklemede yeniden denenir.
    source.logImpression(card.id).catch(() => impressed.delete(card.id));
  };
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const card = nodes.get(entry.target);
              if (card && entry.isIntersecting && entry.intersectionRatio >= 0.5) impress(card);
            }
          },
          { threshold: 0.5 },
        )
      : null;

  const setStatus = (text: string | null, canRetry = false) => {
    status.hidden = text === null;
    message.textContent = text ?? '';
    retry.hidden = !canRetry;
    list.hidden = text !== null;
    region.setAttribute('aria-busy', String(text === t.loading));
  };

  const dismiss = (card: ContentCard, item: HTMLLIElement) => {
    const next = (item.nextElementSibling ?? item.previousElementSibling)?.querySelector<HTMLElement>('.close');
    observer?.unobserve(item);
    nodes.delete(item);
    item.remove();
    if (list.children.length === 0) setStatus(t.empty);
    (next ?? region).focus();
    // Sunucu reddederse kart geri gelsin diye akış yenilenir.
    source.dismiss(card.id).catch(() => void refresh());
  };

  const build = (card: ContentCard): HTMLLIElement => {
    const parts = cardParts(card);
    const item = el('li');
    const article = el('article', { class: 'card' });
    const href = safeUrl(card.url);
    const onClick = (event: Event) => {
      source.logClick(card.id).catch(() => undefined);
      if (options.onCardClick?.(card) === true) event.preventDefault();
    };
    const link = (cls: string, text?: string) => {
      const a = el('a', { class: cls, href: href!, ...(options.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, text);
      a.addEventListener('click', onClick);
      return a;
    };
    const hasButton = parts.includes('button') && !!href;
    // Düğmesi olmayan bağlantılı kartta tüm içerik bağlantıdır; düğme varsa yalnız düğme.
    const body: HTMLElement = href && !hasButton ? link('link') : el('div');
    const name = card.title?.trim() || card.body?.trim() || '';
    if (body.tagName === 'A' && !parts.includes('text')) body.setAttribute('aria-label', name || href!);
    const src = parts.includes('image') ? safeUrl(card.imageUrl) : null;
    if (src) body.appendChild(el('img', { src, alt: parts.includes('text') ? '' : name, loading: 'lazy', decoding: 'async' }));
    if (parts.includes('text') || !src) {
      const text = el('div', { class: 'text' });
      if (card.pinned) text.appendChild(el('span', { class: 'pin' }, t.pinned));
      if (card.title?.trim()) text.appendChild(el('h3', {}, card.title));
      if (card.body?.trim()) text.appendChild(el('p', {}, card.body));
      if (hasButton) text.appendChild(link('btn', card.buttonText!));
      body.appendChild(text);
    }
    const close = el('button', { type: 'button', class: 'close', 'aria-label': name ? `${t.dismiss}: ${name}` : t.dismiss }, '×');
    close.addEventListener('click', () => dismiss(card, item));
    article.append(body, close);
    item.appendChild(article);
    return item;
  };

  async function refresh(): Promise<void> {
    if (destroyed) return;
    const mine = ++seq;
    if (list.children.length === 0) setStatus(t.loading);
    try {
      const feed = await source.list(options.limit ?? 50);
      if (destroyed || mine !== seq) return;
      observer?.disconnect();
      nodes.clear();
      list.replaceChildren();
      for (const card of feed.cards) {
        const item = build(card);
        nodes.set(item, card);
        list.appendChild(item);
        if (observer) observer.observe(item);
        else impress(card);
      }
      setStatus(feed.cards.length === 0 ? t.empty : null);
      options.onFeedLoaded?.(feed);
    } catch {
      if (destroyed || mine !== seq) return;
      // Eldeki kartlar korunur; yalnız boş akışta hata durumu gösterilir.
      if (list.children.length === 0) setStatus(t.error, true);
    }
  }

  retry.addEventListener('click', () => void refresh());
  void refresh();

  return {
    refresh,
    destroy: () => {
      destroyed = true;
      observer?.disconnect();
      nodes.clear();
      host.remove();
    },
  };
}
