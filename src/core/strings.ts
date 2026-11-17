/**
 * Web SDK son kullanıcı metinleri (ADR-0084). Türkçe ve İngilizce pakete gömülüdür; diğer 20 dil
 * `<api>/sdk-web/i18n/<dil>.json` dosyasından SDK başlarken arka planda yüklenir (ana paket boyutu artmaz). Yüklenene
 * kadar ya da yükleme başarısız olursa İngilizce kullanılır. Kaynak kataloglar `sdk/web/i18n/*.json`; bu dosyadaki tr/en
 * tabloları bir testle o kataloglarla birebir eşit tutulur. Sohbet penceresi, web kampanyası ve arama penceresi ayrı paketlerdir: kendi
 * tr/en metinlerini taşır, diğer dilleri SDK onlara aktarır (`loadedSection`).
 */

/** Desteklenen diller (`packages/shared/src/locales.ts` ile aynı; SDK bağımsız paket olduğu için kopyadır, test eşitler). */
export const SDK_LOCALES = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'uk', 'ar', 'az', 'ja', 'ko', 'zh-CN', 'hi', 'id', 'vi', 'th', 'sv', 'ro'] as const;
export type SdkLocale = (typeof SDK_LOCALES)[number];

export interface MainStrings {
  prompt: {
    title: string;
    message: string;
    accept: string;
    cancel: string;
    categoriesTitle: string;
    subscribed: string;
    unsubscribed: string;
    collectTitle: string;
    collectMessage: string;
    collectAccept: string;
    emailLabel: string;
    smsLabel: string;
    invalidEmail: string;
    emailPlaceholder: string;
    invalidPhone: string;
    locationTitle: string;
    locationMessage: string;
    locationAccept: string;
  };
  customLink: { subscribe: string; unsubscribe: string; explanation: string };
  welcome: { message: string };
  /** `slide`: `{n}` sıra, `{total}` toplam. */
  inApp: { close: string; message: string; carousel: string; previous: string; next: string; slide: string };
}

export type CatalogSection = 'campaign' | 'chat' | 'search';
export type SdkCatalog = MainStrings & Record<CatalogSection, Record<string, string>>;

export const BUILTIN_STRINGS: Record<'tr' | 'en', MainStrings> = {
  tr: {
    prompt: {
      title: 'Bildirimleri açmak ister misiniz?',
      message: 'Önemli güncellemeleri ve kampanyaları anında alın.',
      accept: 'İzin ver',
      cancel: 'Şimdi değil',
      categoriesTitle: 'Hangi konularda bildirim almak istersiniz?',
      subscribed: 'Bildirimlere abonesiniz',
      unsubscribed: 'Bildirimlere abone ol',
      collectTitle: 'Haberdar olmak ister misiniz?',
      collectMessage: 'Kampanya ve güncellemeleri size ulaştıralım.',
      collectAccept: 'Kaydol',
      emailLabel: 'E-posta adresi',
      smsLabel: 'Telefon numarası',
      invalidEmail: 'Geçerli bir e-posta adresi girin (ör. ad@pushizo.com).',
      emailPlaceholder: 'ad@pushizo.com',
      invalidPhone: 'Telefonu uluslararası biçimde girin (ör. +905321234567).',
      locationTitle: 'Konumunuzu paylaşın',
      locationMessage:
        'Yakınınızdaki ilgili bildirimleri gönderebilmek için yaklaşık konumunuzu yalnızca site açıkken kullanırız. Bu ayarı istediğiniz zaman kapatabilirsiniz.',
      locationAccept: 'Devam',
    },
    customLink: {
      subscribe: 'Bildirimlere abone ol',
      unsubscribe: 'Bildirim aboneliğinden çık',
      explanation: 'Önemli güncellemeleri ve kampanyaları anında alın.',
    },
    welcome: { message: 'Abone olduğunuz için teşekkürler!' },
    inApp: { close: 'Kapat', message: 'Mesaj', carousel: 'Kartlar', previous: 'Önceki kart', next: 'Sonraki kart', slide: 'Kart {n}/{total}' },
  },
  en: {
    prompt: {
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
      invalidEmail: 'Enter a valid email address (e.g. name@pushizo.com).',
      emailPlaceholder: 'name@pushizo.com',
      invalidPhone: 'Enter the phone in international format (e.g. +14155550100).',
      locationTitle: 'Share your location',
      locationMessage:
        'We use your approximate location only while the site is open, to send you relevant nearby notifications. You can turn this off at any time.',
      locationAccept: 'Continue',
    },
    customLink: {
      subscribe: 'Subscribe to push notifications',
      unsubscribe: 'Unsubscribe from push notifications',
      explanation: 'Get important updates and offers instantly.',
    },
    welcome: { message: 'Thanks for subscribing!' },
    inApp: { close: 'Close', message: 'Message', carousel: 'Cards', previous: 'Previous card', next: 'Next card', slide: 'Card {n} of {total}' },
  },
};

const loaded = new Map<string, Partial<SdkCatalog>>();
const pending = new Map<string, Promise<void>>();
const byLower = new Map<string, SdkLocale>(SDK_LOCALES.map((c) => [c.toLowerCase(), c]));

/** Dil etiketini desteklenen koda eşler (`de-AT` → `de`, `pt` → `pt-BR`, `zh-Hans-CN` → `zh-CN`); yoksa `en`. */
export function resolveSdkLocale(language: string | null | undefined): SdkLocale {
  const norm = (language ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (!norm) return 'en';
  const exact = byLower.get(norm);
  if (exact) return exact;
  const primary = norm.split('-')[0]!;
  if (primary === 'zh') return /(^|-)(hant|tw|hk|mo)(-|$)/.test(norm) ? 'en' : 'zh-CN';
  if (primary === 'pt') return 'pt-BR';
  return byLower.get(primary) ?? 'en';
}

/** Yazım yönü (ADR-0084): Arapça sağdan sola; arayüz kökleri `dir` alır, stiller mantıksal özelliklerle aynalanır (Faz 74). */
export function sdkDirection(language: string | null | undefined): 'ltr' | 'rtl' {
  return resolveSdkLocale(language) === 'ar' ? 'rtl' : 'ltr';
}

/** `{ad}` yer tutucularını doldurur; bilinmeyen yer tutucu olduğu gibi kalır. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Ana paket metinleri; yüklenmemiş dil İngilizceye, eksik anahtar İngilizce karşılığına düşer. */
export function sdkStrings(language: string | null | undefined): MainStrings {
  const code = resolveSdkLocale(language);
  if (code === 'tr' || code === 'en') return BUILTIN_STRINGS[code];
  const cat = loaded.get(code);
  const en = BUILTIN_STRINGS.en;
  if (!cat) return en;
  return {
    prompt: { ...en.prompt, ...cat.prompt },
    customLink: { ...en.customLink, ...cat.customLink },
    welcome: { ...en.welcome, ...cat.welcome },
    inApp: { ...en.inApp, ...cat.inApp },
  };
}

/** Ayrı paketlere (sohbet, web kampanyası) aktarılacak bölüm; tr/en ya da yüklenmemiş dilde `undefined` (paket kendi metnini kullanır). */
export function loadedSection(language: string | null | undefined, section: CatalogSection): Record<string, string> | undefined {
  const code = resolveSdkLocale(language);
  if (code === 'tr' || code === 'en') return undefined;
  return loaded.get(code)?.[section];
}

/**
 * Dil kataloğunu yükler (tr/en ya da zaten yüklüyse hiçbir şey yapmaz; aynı dil için tek istek). Hata fırlatmaz:
 * ağ ya da biçim hatasında İngilizce kalır.
 */
export function loadSdkStrings(baseUrl: string, language: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<void> {
  const code = resolveSdkLocale(language);
  if (code === 'tr' || code === 'en' || loaded.has(code)) return Promise.resolve();
  const inFlight = pending.get(code);
  if (inFlight) return inFlight;
  const task = (async () => {
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/sdk-web/i18n/${code}.json`, { credentials: 'omit' });
      if (!res.ok) return;
      const body = (await res.json()) as unknown;
      if (body && typeof body === 'object' && !Array.isArray(body)) loaded.set(code, body);
    } catch {
      /* İngilizceye düşülür. */
    } finally {
      pending.delete(code);
    }
  })();
  pending.set(code, task);
  return task;
}

/** Testler için önbelleği temizler. */
export function resetSdkStrings(): void {
  loaded.clear();
  pending.clear();
}
