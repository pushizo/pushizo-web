/** Sunucunun döndürdüğü bayrak (ADR-0066). */
export interface FeatureFlagValue {
  enabled: boolean;
  value: unknown;
}
export type FeatureFlagMap = Record<string, FeatureFlagValue>;

/** Sunucu yanıtını doğrular; bozuk satır atlanır. Yanıt tümüyle bozuksa `null` (son değerler korunur). */
export function parseFeatureFlags(response: unknown): FeatureFlagMap | null {
  const flags = (response as { flags?: unknown } | null | undefined)?.flags;
  if (typeof flags !== 'object' || flags === null) return null;
  const out: FeatureFlagMap = {};
  for (const [key, raw] of Object.entries(flags)) {
    const item = raw as { enabled?: unknown; value?: unknown } | null;
    if (item && typeof item.enabled === 'boolean') out[key] = { enabled: item.enabled, value: item.value };
  }
  return out;
}

/** Kova için kalıcı rastgele kimlik: abonelik yokken de aynı kullanıcı aynı sonucu alır. */
export function newFlagSubject(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `anon_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
