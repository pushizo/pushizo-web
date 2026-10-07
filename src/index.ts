import { createSdk, HeroSignalSdk } from './sdk.js';

export { HeroSignalSdk };
export type * from './core/types.js';
export { ApiError } from './core/api.js';
export { ContactValidationError, normalizeEmail, normalizePhone } from './core/contact.js';

/** Tek paylaşılan örnek (ESM kullanımı: `import HeroSignal from '@herosignal/web'`). */
export const HeroSignal: HeroSignalSdk = createSdk();
export default HeroSignal;
