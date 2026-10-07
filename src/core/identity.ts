/** Alias etiketi kuralı (sunucu ile aynı): küçük harf, rakam, alt çizgi; en fazla 50 karakter. */
const ALIAS_LABEL = /^[a-z0-9_]{1,50}$/;
/** Bu etiketler alias uçlarıyla değiştirilemez (external_id → login/logout, hs_id → sistem). */
const RESERVED_LABELS = new Set(['external_id', 'hs_id']);
/** Tek istekte en fazla alias (SDK API sınırı). */
export const MAX_ALIASES_PER_REQUEST = 20;

/** Alias etiketini doğrular; geçersizse açıklayıcı hata fırlatır. */
export function assertAliasLabel(label: string): void {
  if (!ALIAS_LABEL.test(label))
    throw new Error(
      `Geçersiz alias etiketi "${label}": küçük harf, rakam ve alt çizgi (en fazla 50).`,
    );
  if (RESERVED_LABELS.has(label))
    throw new Error(
      `"${label}" alias olarak ayarlanamaz (external_id için login/logout kullanın).`,
    );
}

/** Alias haritasını doğrular ve değerleri kırpar; boş değerler kabul edilmez. */
export function normalizeAliases(aliases: Record<string, string>): Record<string, string> {
  const entries = Object.entries(aliases);
  if (entries.length === 0) throw new Error('En az bir alias gerekli.');
  if (entries.length > MAX_ALIASES_PER_REQUEST)
    throw new Error(`Tek seferde en fazla ${MAX_ALIASES_PER_REQUEST} alias eklenebilir.`);
  const out: Record<string, string> = {};
  for (const [label, raw] of entries) {
    assertAliasLabel(label);
    const value = String(raw).trim();
    if (!value || value.length > 255)
      throw new Error(`"${label}" alias değeri 1-255 karakter olmalı.`);
    out[label] = value;
  }
  return out;
}
