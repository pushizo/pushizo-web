import { mountChatWidget } from './widget.js';

/** CDN girişi: ana SDK `Pushizo.Chat.show()` bu betiği tembel yükler ve `window.PushizoChatWidget.mount` çağırır. */
(globalThis as unknown as { PushizoChatWidget: { mount: typeof mountChatWidget } }).PushizoChatWidget = { mount: mountChatWidget };
