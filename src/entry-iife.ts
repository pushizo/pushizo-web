import { createSdk, type HeroSignalSdk } from './sdk.js';

type Deferred = (sdk: HeroSignalSdk) => void | Promise<void>;

declare global {
  interface Window {
    HeroSignal: HeroSignalSdk;
    HeroSignalDeferred: Deferred[] | { push: (fn: Deferred) => void };
  }
}

/**
 * CDN/script etiketi girişi: `window.HeroSignal` global'i ve `window.HeroSignalDeferred` kuyruğu.
 * Kullanım:
 *   window.HeroSignalDeferred = window.HeroSignalDeferred || [];
 *   HeroSignalDeferred.push(async (HS) => { await HS.init({ appId: 'app_…' }); });
 */
const sdk = createSdk();
window.HeroSignal = sdk;

const run = (fn: Deferred) => {
  Promise.resolve()
    .then(() => fn(sdk))
    .catch((err: unknown) => console.error('[HeroSignal] deferred hata', err));
};

const pending: Deferred[] = Array.isArray(window.HeroSignalDeferred)
  ? (window.HeroSignalDeferred as Deferred[])
  : [];
window.HeroSignalDeferred = { push: run };
for (const fn of pending) run(fn);
