import { mountContentCards } from './widget.js';

/** CDN girişi: ana SDK `Pushizo.ContentCards.render()` bu betiği tembel yükler ve `window.PushizoContentCards.mount` çağırır. */
(globalThis as unknown as { PushizoContentCards: { mount: typeof mountContentCards } }).PushizoContentCards = { mount: mountContentCards };
