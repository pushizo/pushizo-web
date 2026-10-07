import type { WelcomeNotificationOptions } from '../core/types.js';

const DEFAULT_MESSAGE = {
  tr: 'Abone olduğunuz için teşekkürler!',
  en: 'Thanks for subscribing!',
};

/** Karşılama bildirimini ayırt eden etiket (aynı anda yalnızca bir tane görünür). */
export const WELCOME_TAG = 'hs-welcome';

/**
 * İlk abonelikten sonra yerel olarak gösterilen karşılama bildirimi (eski sağlayıcı `welcomeNotification`).
 * Başlık verilmezse sayfa başlığı, mesaj verilmezse dile göre varsayılan metin, URL verilmezse site kökü kullanılır.
 * `disable: true` ise null döner. Sunucuya teslimat kaydı yazılmaz; tıklama service worker'da URL'yi açar.
 */
export function welcomeNotification(
  options: WelcomeNotificationOptions | undefined,
  language: string,
  pageTitle: string,
  origin: string,
): { title: string; options: NotificationOptions } | null {
  if (options?.disable) return null;
  const message =
    options?.message ?? (language.toLowerCase().startsWith('tr') ? DEFAULT_MESSAGE.tr : DEFAULT_MESSAGE.en);
  const url = options?.url && /^https?:\/\//i.test(options.url) ? options.url : `${origin}/`;
  return {
    title: options?.title || pageTitle || new URL(origin).host,
    options: { body: message, tag: WELCOME_TAG, data: { url, hs: {}, actions: [] } },
  };
}
