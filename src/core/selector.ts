/**
 * Görsel seçici (ADR-0083 §4) için kararlı CSS seçici üretimi: kimlik → test öznitelikleri → sınıf/`nth-of-type`
 * yolu; sonuç sayfada tekil olacak şekilde kısaltılır. Üretilen seçici sunucu kuralına uyar (`<{};` yok, ≤300).
 */
const esc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`));
const TEST_ATTRS = ['data-pushizo', 'data-testid', 'data-test', 'data-qa', 'data-cy'];
/** Otomatik üretilmiş görünen sınıflar (CSS-in-JS özetleri, durum sınıfları) seçiciye alınmaz. */
const STABLE_CLASS = /^[A-Za-z][A-Za-z_-]{1,40}$/;

export function uniqueIn(root: ParentNode, selector: string, el: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

export function buildSelector(el: Element, root: ParentNode = document): string {
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && uniqueIn(root, `#${esc(el.id)}`, el)) return `#${esc(el.id)}`;
  for (const a of TEST_ATTRS) {
    const v = el.getAttribute(a);
    if (v && v.length <= 80 && !/["\\]/.test(v)) {
      const s = `[${a}="${v}"]`;
      if (uniqueIn(root, s, el)) return s;
    }
  }
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 8 && node.tagName !== 'HTML'; depth++) {
    let part = node.tagName.toLowerCase();
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) part = `#${esc(node.id)}`;
    else {
      const classes = Array.from(node.classList).filter((c) => STABLE_CLASS.test(c)).slice(0, 2);
      if (classes.length) part += classes.map((c) => `.${esc(c)}`).join('');
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    const sel = parts.join(' > ');
    if (uniqueIn(root, sel, el) || sel.length > 260) return sel.slice(0, 300);
    if (part.startsWith('#')) break;
    node = node.parentElement;
  }
  return parts.join(' > ').slice(0, 300);
}
