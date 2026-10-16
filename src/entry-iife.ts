import { createSdk, type PushizoSdk } from './sdk.js';

type Deferred = (sdk: PushizoSdk) => void | Promise<void>;

declare global {
  interface Window {
    Pushizo: PushizoSdk;
    PushizoDeferred: Deferred[] | { push: (fn: Deferred) => void };
  }
}

/**
 * CDN/script etiketi girişi: `window.Pushizo` global'i ve `window.PushizoDeferred` kuyruğu.
 * Kullanım:
 *   window.PushizoDeferred = window.PushizoDeferred || [];
 *   PushizoDeferred.push(async (HS) => { await HS.init({ appId: 'app_…' }); });
 */
const sdk = createSdk();
window.Pushizo = sdk;

const run = (fn: Deferred) => {
  Promise.resolve()
    .then(() => fn(sdk))
    .catch((err: unknown) => console.error('[Pushizo] deferred hata', err));
};

const pending: Deferred[] = Array.isArray(window.PushizoDeferred)
  ? (window.PushizoDeferred as Deferred[])
  : [];
window.PushizoDeferred = { push: run };
for (const fn of pending) run(fn);
