/**
 * İstemci olay kimliği (`event_id`): olay kuyruğa alınırken bir kez üretilir ve yeniden denemelerde aynı kalır;
 * sunucu aynı `event_id` + `occurred_at` ikilisini ikinci kez kaydetmez (v2 sertleştirme, ADR-0022).
 * `crypto.randomUUID` yoksa (eski tarayıcı, güvenli olmayan bağlam) `getRandomValues` ile 128 bit rastgele değer.
 */
export function newEventId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
