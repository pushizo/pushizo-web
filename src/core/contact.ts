import type { ContactChannel } from './types.js';

// Kurallar sunucuyla aynıdır (packages/shared/src/messaging.ts); SDK bağımlılıksız kalsın diye kopyalanmıştır.
const EMAIL_PATTERN =
  /^[^\s@"(),:;<>[\\\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Geçersiz e-posta/telefon: mesajda adresin kendisi yer almaz (kişisel veri loglara düşmesin). */
export class ContactValidationError extends Error {
  constructor(readonly channel: ContactChannel) {
    super(
      channel === 'email'
        ? 'Geçersiz e-posta adresi (ör. ad@ornek.com).'
        : 'Geçersiz telefon numarası: uluslararası E.164 biçimi gerekli (ör. +905321234567).',
    );
    this.name = 'ContactValidationError';
  }
}

/** E-posta adresini kırpar ve küçük harfe çevirir; geçersizse null. */
export function normalizeEmail(value: string): string | null {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (v.length > 320 || !EMAIL_PATTERN.test(v)) return null;
  return v;
}

/** Telefonu E.164'e normalize eder (boşluk, tire, parantez, nokta atılır; `00` → `+`); geçersizse null. */
export function normalizePhone(value: string): string | null {
  let v = String(value ?? '')
    .trim()
    .replace(/[\s().-]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  return E164_PATTERN.test(v) ? v : null;
}

/** Kanal adresini normalize eder; geçersizse `ContactValidationError` fırlatır. */
export function normalizeContact(channel: ContactChannel, value: string): string {
  const normalized = channel === 'email' ? normalizeEmail(value) : normalizePhone(value);
  if (normalized === null) throw new ContactValidationError(channel);
  return normalized;
}
