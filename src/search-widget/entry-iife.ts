import { mountSearchWidget } from './widget.js';

/** CDN girişi: ana SDK `Pushizo.Search.open()` bu betiği tembel yükler ve `window.PushizoSearchWidget.mount` çağırır. */
(globalThis as unknown as { PushizoSearchWidget: { mount: typeof mountSearchWidget } }).PushizoSearchWidget = { mount: mountSearchWidget };
