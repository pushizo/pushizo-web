import { createSdk, PushizoSdk } from './sdk.js';

export { PushizoSdk };
export type * from './core/types.js';
export { ApiError } from './core/api.js';
export type {
  ChatAttachment,
  ChatConfig,
  ChatConversation,
  ChatEvents,
  ChatMessage,
  ChatQuickReply,
  ChatWidgetHandle,
  ChatWidgetModule,
  ChatWidgetMountOptions,
  ChatWidgetOptions,
} from './core/chat.js';
export { ContactValidationError, normalizeEmail, normalizePhone } from './core/contact.js';

/** Tek paylaşılan örnek (ESM kullanımı: `import Pushizo from '@pushizo/web'`). */
export const Pushizo: PushizoSdk = createSdk();
export default Pushizo;
