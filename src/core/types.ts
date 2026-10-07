export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export type Channel = 'ios_push' | 'android_push' | 'web_push' | 'email' | 'sms';

export interface DeviceInfo {
  model?: string;
  os?: string;
  os_version?: string;
  app_version?: string;
  sdk_version?: string;
  sdk_platform?: string;
  locale?: string;
  timezone?: string;
  push_capable?: boolean;
  /** iOS: APNs ortamı (web'de gönderilmez; sözleşme bütünlüğü için). */
  push_environment?: 'sandbox' | 'production';
}

/** Bildirim aksiyon düğmesi (`hs.buttons`). */
export interface HsButton {
  id: string;
  title: string;
  url?: string;
  icon?: string;
}

/**
 * Push payload'ında SDK'nın beklediği `hs` alanı (worker payload'ı).
 * Yeni biçim `dlv`/`msg`/`buttons`; `delivery_id` eski sürümlerle uyumluluk için korunur.
 */
export interface HsPayloadMeta {
  dlv?: string;
  delivery_id?: string;
  msg?: string;
  url?: string;
  buttons?: HsButton[];
  [key: string]: unknown;
}

/** Service worker'a gelen Web Push gövdesi (sağlayıcı payload'ı, bkz. packages/providers webpush). */
export interface WebPushPayload {
  title?: string;
  body?: string;
  icon?: string;
  image?: string;
  badge?: string;
  url?: string;
  tag?: string;
  requireInteraction?: boolean;
  actions?: { action: string; title: string; icon?: string; url?: string }[];
  /** Müşteri özel verisi. */
  data?: Record<string, unknown>;
  hs?: HsPayloadMeta;
}

export interface SlidedownOptions {
  enabled?: boolean;
  /** Sayfa yüklendikten kaç saniye sonra gösterilsin. */
  delaySeconds?: number;
  /** Kaçıncı sayfa görüntülemeden itibaren. */
  pageViews?: number;
  /** Sayfa en az bu yüzde (0-100) kaydırıldıktan sonra gösterilir (diğer tetiklerle birlikte). */
  scrollPercent?: number;
  /** Kategori seçimi: işaretlenen her kategori için `tag` = "1" yazılır, işareti kaldırılan silinir. */
  categories?: SlidedownCategory[];
  /** Kategori listesinin başlığı (varsayılan dil metni). */
  categoriesTitle?: string;
  /** Kabul düğmesi rengi (#rrggbb); geçersiz değer yok sayılır. */
  accentColor?: string;
  /** Reddedilince kaç gün sonra tekrar gösterilsin. */
  retryDays?: number;
  title?: string;
  message?: string;
  acceptText?: string;
  cancelText?: string;
}

export interface SlidedownCategory {
  /** Tag anahtarı. */
  tag: string;
  /** Kullanıcıya gösterilen etiket. */
  label: string;
  /** Kullanıcının tag'i yoksa varsayılan işaret durumu. */
  checked?: boolean;
}

export interface BellOptions {
  enabled?: boolean;
  position?: 'bottom-right' | 'bottom-left';
  subscribedText?: string;
  unsubscribedText?: string;
}

export interface InitOptions {
  appId: string;
  /** API kökü, örn. https://api.herosignal.dev (varsayılan: SDK'nın yüklendiği origin). */
  apiUrl?: string;
  /** Service worker yolu (site origin'inde), varsayılan `/HeroSignalSDKWorker.js`. */
  serviceWorkerPath?: string;
  serviceWorkerScope?: string;
  /** HTTP localhost üzerinde çalışmaya izin ver (geliştirme). */
  allowLocalhostAsSecureOrigin?: boolean;
  /** KVKK/GDPR: onay verilene kadar ağ çağrısı yapılmaz. */
  requiresPrivacyConsent?: boolean;
  /** İzin alındıktan sonra otomatik abone ol (varsayılan true). */
  autoResubscribe?: boolean;
  /** Oturum başlangıcında tarayıcı native istemini otomatik aç. */
  autoPrompt?: boolean;
  slidedown?: SlidedownOptions;
  bell?: BellOptions;
  logLevel?: LogLevel;
  /** Dil (slidedown/bell metinleri ve `device.locale`); varsayılan navigator.language. */
  language?: string;
}

export interface PushSubscriptionState {
  id: string | null;
  token: string | null;
  optedIn: boolean;
  permission: PermissionState;
}

export interface NotificationClickEvent {
  notification: {
    title: string;
    body: string;
    url?: string;
    deliveryId?: string;
    messageId?: string;
    data: Record<string, unknown>;
  };
  result: { actionId?: string; url?: string };
}

export interface ForegroundLifecycleEvent {
  notification: {
    title: string;
    body: string;
    deliveryId?: string;
    messageId?: string;
    data: Record<string, unknown>;
  };
  /** Çağrılırsa bildirim gösterilmez. */
  preventDefault: () => void;
}

/** Cihazda saklanan SDK durumu. */
export interface PersistedState {
  subscriptionId: string | null;
  userId: string | null;
  externalId: string | null;
  /** Kimlik doğrulama (identity verification) hash'i; login ile verilir, logout ile silinir. */
  identityHash: string | null;
  tags: Record<string, string>;
  optedIn: boolean;
  consentGiven: boolean;
  tokenHash: string | null;
  /** Gerçek PushSubscription endpoint'i (`pushSubscription.token`). */
  pushEndpoint: string | null;
  slidedownDismissedAt: number | null;
  pageViews: number;
  queue: QueuedOperation[];
  /** `User.addEmail`/`addSms` ile eklenen abonelikler (adres düz metin değil, SHA-256 özeti saklanır). */
  contactSubscriptions: ContactSubscription[];
  /** In-app sıklık için yerel gösterim kaydı (mesaj kimliği → kayıt). */
  inAppLocal: Record<string, InAppLocalRecord>;
}

/** E-posta/SMS kanalı (web SDK'nın eklediği ek abonelikler). */
export type ContactChannel = 'email' | 'sms';

export interface ContactSubscription {
  channel: ContactChannel;
  /** Normalize edilmiş adresin SHA-256 özeti. */
  tokenHash: string;
  subscriptionId: string;
  /** Aboneliğin bağlı olduğu kullanıcı (`register`/`login` yanıtı). */
  userId: string;
  /** Bağlı kullanıcının external_id'si (anonimse null); login'de yeniden bağlama kararı için. */
  externalId: string | null;
  /** Kanonik adresin SHA-256 özeti (sunucudaki `token_hash`); login/bağlama sahiplik kanıtı (ADR-0016). */
  ownershipHash?: string;
}

/** Bir in-app mesajın cihazdaki gösterim bilgisi. */
export interface InAppLocalRecord {
  /** Son gösterim anı (epoch ms). */
  lastAt: number;
  /** Sunucuya henüz ulaşmamış (kuyrukta bekleyen) gösterim sayısı. */
  pending: number;
  /** Bu cihazda tıklandı/kapatıldı (`stop_after_interaction` mesajlarında yeniden gösterimi engeller). */
  interacted?: boolean;
}

// --- In-app mesajlar (docs/messaging.md §7) ---

export type InAppTriggerOperator = 'eq' | 'neq' | 'exists' | 'gt' | 'lt';

/** Mesajın gösterim koşulu; bir mesajın tüm koşulları aynı anda sağlanmalıdır. */
export type InAppTrigger =
  | { kind: 'session_start' }
  | { kind: 'event'; name: string }
  | { kind: 'screen'; name: string }
  | { kind: 'trigger'; key: string; op: InAppTriggerOperator; value?: string | number };

export type InAppAction =
  | { type: 'dismiss' }
  | { type: 'url'; url: string }
  | { type: 'deeplink'; url: string }
  | { type: 'tags'; tags: Record<string, string> };

export type InAppBlock =
  | { type: 'image'; url: string; alt: string | null }
  | { type: 'title'; text: string }
  | { type: 'body'; text: string }
  | {
      type: 'button';
      id: string;
      text: string;
      action: InAppAction;
      background_color: string | null;
      text_color: string | null;
    };

export type InAppLayout = 'modal' | 'banner_top' | 'banner_bottom' | 'fullscreen';

export interface InAppDisplay {
  layout: InAppLayout;
  background_color: string | null;
  text_color: string | null;
  dismissible: boolean;
  auto_dismiss_seconds: number | null;
  blocks: InAppBlock[];
}

/** `GET /sdk/v1/apps/{appId}/in-app` öğesi (metinler kullanıcının dilinde çözülmüş). */
export interface InAppMessage {
  id: string;
  priority: number;
  triggers: InAppTrigger[];
  display: InAppDisplay;
  remaining_impressions: number;
  min_interval_seconds: number;
  last_impression_at: string | null;
  end_at: string | null;
  /** Tıklama/kapatma sonrası kullanıcıya bir daha gösterilmez. */
  stop_after_interaction: boolean;
}

/** `InAppMessages.addTrigger` değeri. */
export type InAppTriggerValue = string | number | boolean;

export interface InAppClickEvent {
  message: { id: string };
  /** `actionId` tıklanan düğmenin kimliği; `url` aksiyonun adresi (varsa). */
  result: { actionId: string; url?: string };
}

export interface InAppLifecycleEvent {
  message: { id: string };
}

/** In-app yaşam döngüsü dinleyicisi; yalnızca ilgilenilen alanlar verilir. */
export interface InAppLifecycleListener {
  willDisplay?: (event: InAppLifecycleEvent) => void;
  didDisplay?: (event: InAppLifecycleEvent) => void;
  willDismiss?: (event: InAppLifecycleEvent) => void;
  didDismiss?: (event: InAppLifecycleEvent) => void;
}

// --- Bildirim kutusu (docs/messaging.md §8) ---

export interface InboxItem {
  id: string;
  messageId: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  imageUrl: string | null;
  data: Record<string, string>;
  read: boolean;
  readAt: string | null;
  archivedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface InboxPage {
  items: InboxItem[];
  unreadCount: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface InboxListOptions {
  /** 1-200 (varsayılan 50). */
  limit?: number;
  cursor?: string;
}

/** `Inbox.addObserver` olayı: okunmamış sayısı veya öğeler değiştiğinde. */
export interface InboxChangeEvent {
  type: 'listed' | 'read' | 'read_all' | 'archived' | 'count';
  itemId?: string;
  unreadCount: number;
}

export type QueuedOperation =
  | { type: 'tags'; tags: Record<string, string | null>; at: number }
  | { type: 'properties'; properties: Record<string, unknown>; at: number }
  | { type: 'event'; name: string; properties?: Record<string, unknown>; value?: number; occurredAt: string; at: number }
  | { type: 'session_start'; at: number }
  | { type: 'session_end'; durationSeconds: number; at: number }
  /** `aliases` yeni biçim; `label`/`value` eski sürümlerin kuyruğa yazdığı tekil alias. */
  | { type: 'alias_add'; aliases?: Record<string, string>; label?: string; value?: string; at: number }
  | { type: 'alias_remove'; label: string; at: number }
  | { type: 'received'; deliveryId: string; at: number }
  | { type: 'opened'; deliveryId: string; buttonId?: string; at: number }
  /** E-posta/SMS aboneliği ekleme (`token` normalize edilmiş adres; gönderilince kuyruktan silinir). */
  | { type: 'contact_add'; channel: ContactChannel; token: string; at: number }
  | { type: 'contact_remove'; channel: ContactChannel; token: string; at: number }
  /** In-app gösterim/tıklama/kapatma; olay anındaki abonelik kimliğiyle gönderilir. */
  | {
      type: 'in_app_event';
      messageId: string;
      subscriptionId: string;
      eventType: 'impression' | 'click' | 'dismiss';
      buttonId?: string;
      at: number;
    }
  /** Kuyruk flush'ında ardışık olaylardan oluşturulan toplu gönderim (kalıcı saklanmaz). */
  | { type: 'event_batch'; events: Extract<QueuedOperation, { type: 'event' }>[]; at: number };

/** Service worker → sayfa mesajları. */
export type WorkerMessage =
  | { type: 'hs:notification-click'; payload: WebPushPayload; actionId?: string; url?: string }
  | { type: 'hs:subscription-change'; subscription: PushSubscriptionJSON | null }
  | { type: 'hs:received'; deliveryId: string }
  | { type: 'hs:push-received'; payload: WebPushPayload };
