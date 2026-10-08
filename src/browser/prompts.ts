import type { RemoteCustomLinkConfig, RemotePromptConfig, RemoteWelcomeConfig } from '../core/api.js';
import { normalizeEmail, normalizePhone } from '../core/contact.js';
import type {
  BellOptions,
  CustomLinkOptions,
  SlidedownCategory,
  SlidedownCollect,
  SlidedownOptions,
  WelcomeNotificationOptions,
} from '../core/types.js';

const TEXTS = {
  tr: {
    title: 'Bildirimleri açmak ister misiniz?',
    message: 'Önemli güncellemeleri ve kampanyaları anında alın.',
    accept: 'İzin ver',
    cancel: 'Şimdi değil',
    categoriesTitle: 'Hangi konularda bildirim almak istersiniz?',
    subscribed: 'Bildirimlere abonesiniz',
    unsubscribed: 'Bildirimlere abone ol',
    // E-posta/SMS toplama istemi (ADR-0019 §11)
    collectTitle: 'Haberdar olmak ister misiniz?',
    collectMessage: 'Kampanya ve güncellemeleri size ulaştıralım.',
    collectAccept: 'Kaydol',
    emailLabel: 'E-posta adresi',
    smsLabel: 'Telefon numarası',
    invalidEmail: 'Geçerli bir e-posta adresi girin (ör. ad@ornek.com).',
    invalidPhone: 'Telefonu uluslararası biçimde girin (ör. +905321234567).',
  },
  en: {
    title: 'Enable notifications?',
    message: 'Get important updates and offers instantly.',
    accept: 'Allow',
    cancel: 'Not now',
    categoriesTitle: 'Which topics would you like to hear about?',
    subscribed: 'You are subscribed to notifications',
    unsubscribed: 'Subscribe to notifications',
    collectTitle: 'Stay in the loop?',
    collectMessage: 'Get offers and updates delivered to you.',
    collectAccept: 'Sign up',
    emailLabel: 'Email address',
    smsLabel: 'Phone number',
    invalidEmail: 'Enter a valid email address (e.g. name@example.com).',
    invalidPhone: 'Enter the phone in international format (e.g. +14155550100).',
  },
};

function texts(language: string) {
  return language.toLowerCase().startsWith('tr') ? TEXTS.tr : TEXTS.en;
}

const STYLE_ID = 'hs-prompt-style';
const CSS = `
.hs-slidedown{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483000;max-width:480px;width:calc(100% - 32px);background:#fff;color:#111;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:16px;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:hs-in .25s ease}
@media (prefers-color-scheme:dark){.hs-slidedown{background:#1f2227;color:#f3f4f6}}
.hs-slidedown h3{margin:0 0 4px;font-size:15px}
.hs-slidedown p{margin:0 0 12px;opacity:.85}
.hs-slidedown fieldset{border:0;margin:0 0 12px;padding:0}
.hs-slidedown legend{padding:0;margin:0 0 6px;font-weight:600;font-size:13px}
.hs-slidedown .hs-category{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer}
.hs-slidedown .hs-category input{width:16px;height:16px;margin:0;accent-color:#2563eb}
.hs-slidedown .hs-field{display:block;margin:0 0 10px}
.hs-slidedown .hs-field span{display:block;font-size:12px;font-weight:600;margin:0 0 4px;opacity:.85}
.hs-slidedown .hs-field input{box-sizing:border-box;width:100%;border:1px solid rgba(127,127,127,.45);border-radius:8px;padding:8px 10px;font:inherit;background:transparent;color:inherit}
.hs-slidedown .hs-field input:focus{outline:2px solid #2563eb;outline-offset:1px}
.hs-slidedown .hs-field input[aria-invalid="true"]{border-color:#dc2626}
.hs-slidedown .hs-error{margin:-4px 0 10px;color:#dc2626;font-size:12px}
.hs-slidedown .hs-error:empty{display:none}
.hs-slidedown .hs-actions{display:flex;gap:8px;justify-content:flex-end}
.hs-slidedown button{border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
.hs-slidedown .hs-accept{background:#2563eb;color:#fff}
.hs-slidedown .hs-cancel{background:transparent;color:inherit;opacity:.8}
.hs-bell{position:fixed;bottom:20px;z-index:2147483000;width:48px;height:48px;border-radius:50%;border:0;background:#2563eb;color:#fff;box-shadow:0 6px 20px rgba(37,99,235,.4);cursor:pointer;display:flex;align-items:center;justify-content:center}
.hs-bell.hs-right{right:20px}.hs-bell.hs-left{left:20px}
.hs-bell[data-subscribed="true"]{background:#16a34a;box-shadow:0 6px 20px rgba(22,163,74,.4)}
@keyframes hs-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Dil kodu → metin haritasından seçim: geçerli dil, yoksa en, tr, ilk değer. */
export function pickLocalized<T>(map: Record<string, T> | undefined, language: string): T | undefined {
  if (!map) return undefined;
  const lang = language.slice(0, 2).toLowerCase();
  return map[lang] ?? map.en ?? map.tr ?? Object.values(map)[0];
}

/** Dashboard karşılama bildirimi → init seçeneği biçimi (geçerli dile göre). */
export function welcomeFromRemote(remote: RemoteWelcomeConfig, language: string): WelcomeNotificationOptions {
  const texts = pickLocalized(remote.texts, language);
  return { disable: !remote.enabled, title: texts?.title, message: texts?.message, url: remote.url };
}

/** Dashboard özel bağlantı istemi → init seçeneği biçimi (geçerli dile göre). */
export function customLinkFromRemote(remote: RemoteCustomLinkConfig, language: string): CustomLinkOptions {
  return {
    enabled: remote.enabled,
    style: remote.style,
    size: remote.size,
    color: remote.color,
    text: pickLocalized(remote.texts, language),
    unsubscribeEnabled: remote.unsubscribeEnabled,
  };
}

/** Dashboard istemi (`config.web.prompt`) → slidedown seçenekleri (geçerli dile göre). */
export function slidedownFromRemote(prompt: RemotePromptConfig, language: string): SlidedownOptions {
  const texts = pickLocalized(prompt.texts, language);
  return {
    enabled: prompt.enabled,
    delaySeconds: prompt.delaySeconds,
    pageViews: prompt.pageViews,
    scrollPercent: prompt.scrollPercent,
    title: texts?.title,
    message: texts?.message,
    acceptText: texts?.accept,
    cancelText: texts?.cancel,
    categories: prompt.categories
      ?.map((c) => ({ tag: c.tag, label: pickLocalized(c.label, language) ?? c.tag }))
      .filter((c) => c.tag),
    accentColor: prompt.accentColor,
    collect: prompt.collect,
  };
}

/** Slidedown'un e-posta/SMS alanı gösterip göstermediği (`collect` push veya yoksa klasik izin istemi). */
export function collectsContact(collect: SlidedownCollect | undefined): boolean {
  return collect === 'email' || collect === 'sms' || collect === 'email_sms';
}

/** Yalnızca #rrggbb kabul edilir (CSS enjeksiyonuna karşı). */
export function safeAccentColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

/** eski sağlayıcı geri çekilme takvimi: 1. reddin ardından 3, 2. reddin ardından 7, sonrakilerde 30 gün beklenir. */
export const DEFAULT_PROMPT_BACKOFF_DAYS = [3, 7, 30];

/**
 * İzin istemi (slidedown veya otomatik native istem) şimdi gösterilebilir mi?
 * `dismissCount` kez reddedildiyse son retten itibaren takvimin `dismissCount`. adımı kadar gün beklenir;
 * takvim bittiyse son değer tekrarlanır. Boş takvim veya 0 gün geri çekilmeyi kapatır.
 */
export function promptBackoffElapsed(
  dismissCount: number,
  dismissedAt: number | null,
  now: number,
  scheduleDays: readonly number[] = DEFAULT_PROMPT_BACKOFF_DAYS,
): boolean {
  if (!dismissedAt || dismissCount <= 0 || scheduleDays.length === 0) return true;
  const days = scheduleDays[Math.min(dismissCount, scheduleDays.length) - 1] ?? 0;
  return now - dismissedAt >= Math.max(0, days) * 86_400_000;
}

/** Slidedown sonucu; `tags` yalnızca kategori seçimi varsa ve kabul edildiyse doludur. */
export interface SlidedownResult {
  accepted: boolean;
  /** İşaretli kategori → "1", işareti kaldırılan → null (tag silinir). */
  tags: Record<string, string | null>;
  /** `collect` e-posta içeriyorsa ve kabul edildiyse normalize edilmiş adres. */
  email?: string;
  /** `collect` SMS içeriyorsa ve kabul edildiyse E.164 telefon. */
  sms?: string;
}

/** Sayfanın kaydırılma yüzdesi (0-100); kaydırılamayan sayfa tamamen görünür sayılır (100). */
export function scrollPercentOf(scrollTop: number, viewportHeight: number, documentHeight: number): number {
  const scrollable = documentHeight - viewportHeight;
  if (scrollable <= 0) return 100;
  return Math.min(100, Math.max(0, (scrollTop / scrollable) * 100));
}

/** Sayfa belirtilen yüzdeye kadar kaydırılınca çözülür. */
export function waitForScrollPercent(percent: number): Promise<void> {
  const current = () =>
    scrollPercentOf(window.scrollY, window.innerHeight, document.documentElement.scrollHeight);
  return new Promise((resolve) => {
    if (current() >= percent) {
      resolve();
      return;
    }
    const onScroll = () => {
      if (current() < percent) return;
      window.removeEventListener('scroll', onScroll);
      resolve();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  });
}

/** Kategori kutularının seçimini tag yamasına dönüştürür. */
export function categoriesToTags(categories: SlidedownCategory[], checked: ReadonlySet<string>): Record<string, string | null> {
  return Object.fromEntries(categories.map((c) => [c.tag, checked.has(c.tag) ? '1' : null]));
}

/**
 * eski sağlayıcı benzeri "slidedown" izin istemi (native istemden önce yumuşak soru).
 * `options.categories` verilirse kategori onay kutuları gösterilir; ön işaretler `currentTags`'ten gelir.
 */
export function showSlidedown(options: SlidedownOptions, language: string, currentTags: Record<string, string> = {}): Promise<SlidedownResult> {
  ensureStyle();
  const t = texts(language);
  const collect = collectsContact(options.collect) ? options.collect! : 'push';
  const wantsEmail = collect === 'email' || collect === 'email_sms';
  const wantsSms = collect === 'sms' || collect === 'email_sms';
  const categories = (options.categories ?? []).filter((c) => c.tag && c.label);
  const categoriesHtml = categories.length
    ? `<fieldset class="hs-categories"><legend>${escapeHtml(options.categoriesTitle ?? t.categoriesTitle)}</legend>${categories
        .map((c) => {
          const isChecked = c.tag in currentTags ? currentTags[c.tag] !== '0' : c.checked === true;
          return `<label class="hs-category"><input type="checkbox" value="${escapeHtml(c.tag)}"${isChecked ? ' checked' : ''}><span>${escapeHtml(c.label)}</span></label>`;
        })
        .join('')}</fieldset>`
    : '';
  // E-posta/SMS alanları (ADR-0019 §11): yalnızca `collect` istediğinde çizilir.
  const field = (kind: 'email' | 'sms') =>
    `<label class="hs-field hs-field-${kind}"><span>${escapeHtml(
      kind === 'email' ? (options.emailLabel ?? t.emailLabel) : (options.smsLabel ?? t.smsLabel),
    )}</span><input type="${kind === 'email' ? 'email' : 'tel'}" name="hs-${kind}" autocomplete="${
      kind === 'email' ? 'email' : 'tel'
    }" inputmode="${kind === 'email' ? 'email' : 'tel'}" placeholder="${
      kind === 'email' ? 'name@example.com' : '+90 532 123 45 67'
    }" aria-invalid="false"></label>`;
  const fieldsHtml = `${wantsEmail ? field('email') : ''}${wantsSms ? field('sms') : ''}${
    wantsEmail || wantsSms ? '<p class="hs-error" role="alert" aria-live="assertive"></p>' : ''
  }`;
  const isCollect = wantsEmail || wantsSms;
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'hs-slidedown';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('data-hs-collect', collect);
    box.innerHTML = `
      <h3>${escapeHtml(options.title ?? (isCollect ? t.collectTitle : t.title))}</h3>
      <p>${escapeHtml(options.message ?? (isCollect ? t.collectMessage : t.message))}</p>${fieldsHtml}${categoriesHtml}
      <div class="hs-actions">
        <button type="button" class="hs-cancel">${escapeHtml(options.cancelText ?? t.cancel)}</button>
        <button type="button" class="hs-accept">${escapeHtml(options.acceptText ?? (isCollect ? t.collectAccept : t.accept))}</button>
      </div>`;
    const done = (accepted: boolean, contact: { email?: string; sms?: string } = {}) => {
      const checked = new Set(
        Array.from(box.querySelectorAll<HTMLInputElement>('.hs-category input'))
          .filter((input) => input.checked)
          .map((input) => input.value),
      );
      box.remove();
      resolve({
        accepted,
        tags: accepted && categories.length ? categoriesToTags(categories, checked) : {},
        ...(accepted ? contact : {}),
      });
    };
    /** Alanları doğrular; geçersizse hata gösterir ve null döner. Adres mesaja/loga yazılmaz. */
    const readContact = (): { email?: string; sms?: string } | null => {
      const error = box.querySelector<HTMLElement>('.hs-error');
      const emailInput = box.querySelector<HTMLInputElement>('input[name="hs-email"]');
      const smsInput = box.querySelector<HTMLInputElement>('input[name="hs-sms"]');
      const email = emailInput ? normalizeEmail(emailInput.value) : null;
      const sms = smsInput ? normalizePhone(smsInput.value) : null;
      if (emailInput) emailInput.setAttribute('aria-invalid', String(email === null));
      if (smsInput) smsInput.setAttribute('aria-invalid', String(sms === null));
      if (emailInput && email === null) {
        if (error) error.textContent = t.invalidEmail;
        emailInput.focus();
        return null;
      }
      if (smsInput && sms === null) {
        if (error) error.textContent = t.invalidPhone;
        smsInput.focus();
        return null;
      }
      if (error) error.textContent = '';
      return { ...(email ? { email } : {}), ...(sms ? { sms } : {}) };
    };
    const accept = () => {
      if (!isCollect) {
        done(true);
        return;
      }
      const contact = readContact();
      if (contact) done(true, contact);
    };
    const accent = safeAccentColor(options.accentColor);
    if (accent) box.querySelector<HTMLElement>('.hs-accept')!.style.background = accent;
    box.querySelector('.hs-accept')!.addEventListener('click', accept);
    box.querySelector('.hs-cancel')!.addEventListener('click', () => done(false));
    // Enter ile gönderim (alanlar form içinde değil).
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName === 'INPUT' && isCollect) {
        e.preventDefault();
        accept();
      }
    });
    document.body.appendChild(box);
    if (isCollect) box.querySelector<HTMLInputElement>('.hs-field input')?.focus();
  });
}

/** Abone ol / çık düğmesi (bell). */
export function mountBell(options: BellOptions, language: string, state: () => boolean, onToggle: () => void): () => void {
  ensureStyle();
  const t = texts(language);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `hs-bell ${options.position === 'bottom-left' ? 'hs-left' : 'hs-right'}`;
  button.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const refresh = () => {
    const subscribed = state();
    button.dataset.subscribed = String(subscribed);
    button.setAttribute('aria-label', subscribed ? (options.subscribedText ?? t.subscribed) : (options.unsubscribedText ?? t.unsubscribed));
    button.title = button.getAttribute('aria-label') ?? '';
  };
  button.addEventListener('click', onToggle);
  refresh();
  document.body.appendChild(button);
  const timer = setInterval(refresh, 1000);
  return () => {
    clearInterval(timer);
    button.remove();
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
