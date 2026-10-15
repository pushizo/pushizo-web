export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export type Channel = 'ios_push' | 'android_push' | 'web_push' | 'email' | 'sms';

/** Konum (`PATCH /subscriptions/{id}` `location` alanı): enlem -90..90, boylam -180..180, doğruluk 0..100000 m. */
export interface LocationFix {
  lat: number;
  lng: number;
  accuracy_m?: number;
}

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

/**
 * Slidedown'un ne topladığı (ADR-0019 §11): `push` (varsayılan) native izin istemine geçer;
 * `email`, `sms`, `email_sms` adres alanı gösterir ve kabulde `User.addEmail`/`addSms` çağırır.
 */
export type SlidedownCollect = 'push' | 'email' | 'sms' | 'email_sms';

export interface SlidedownOptions {
  enabled?: boolean;
  /** Toplanacak kanal; verilmezse (veya `push`) mevcut push davranışı. */
  collect?: SlidedownCollect;
  /** E-posta alanı etiketi/yer tutucusu (varsayılan dile göre). */
  emailLabel?: string;
  /** Telefon alanı etiketi/yer tutucusu (varsayılan dile göre). */
  smsLabel?: string;
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
  /**
   * Reddedilince kaç gün sonra tekrar gösterilsin (sabit bekleme). Verilmezse eski sağlayıcı geri çekilme takvimi
   * (`promptOptions.backoffDays`, varsayılan 3/7/30 gün) uygulanır.
   */
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

/** İlk abonelikten sonra gösterilen yerel karşılama bildirimi (eski sağlayıcı `welcomeNotification`). */
export interface WelcomeNotificationOptions {
  /** true ise karşılama bildirimi gösterilmez (varsayılan: gösterilir). */
  disable?: boolean;
  /** Başlık (varsayılan: sayfa başlığı). */
  title?: string;
  /** Gövde metni (varsayılan: dile göre "Abone olduğunuz için teşekkürler!"). */
  message?: string;
  /** Tıklanınca açılacak http(s) adresi (varsayılan: site kökü). */
  url?: string;
}

/** `.herosignal-customlink-container` öğelerine çizilen abone ol / çık bağlantısı (eski sağlayıcı custom link). */
export interface CustomLinkOptions {
  enabled?: boolean;
  /** Düğme veya metin bağlantısı (varsayılan `button`). */
  style?: 'button' | 'link';
  size?: 'small' | 'medium' | 'large';
  /** `#rrggbb` renkler: düğme arka planı ve metin. */
  color?: { button?: string; text?: string };
  text?: { subscribe?: string; unsubscribe?: string; explanation?: string };
  /** Abone olunduktan sonra "abonelikten çık" gösterilsin mi (varsayılan false: bağlantı gizlenir). */
  unsubscribeEnabled?: boolean;
}

export interface PromptOptions {
  customlink?: CustomLinkOptions;
  /**
   * Reddedilen istemin yeniden gösterilmesi için gün takvimi (varsayılan `[3, 7, 30]`: 1. ret → 3, 2. → 7,
   * sonrakiler → 30 gün). `[]` geri çekilmeyi kapatır. `slidedown.retryDays` verilmişse sabit bekleme olarak önceliklidir.
   */
  backoffDays?: number[];
}

export interface InitOptions {
  appId: string;
  /**
   * API kökü, örn. https://api.herosignal.dev (varsayılan: SDK'nın yüklendiği origin). Verilmezse veya global kök
   * (`https://api.herosignal.dev`) verilirse SDK app yapılandırmasındaki bölgesel adresi (`api_url`) öğrenip kullanır;
   * özel bir adres verilirse korunur (yalnızca sunucu 421 `HS_WRONG_CELL` ile başka bölgeyi gösterirse oraya
   * geçilir). Ayrıntı: docs/sdk/web.md.
   */
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
  /** İlk abonelikten sonra yerel karşılama bildirimi (varsayılan açık; `{ disable: true }` kapatır). */
  welcomeNotification?: WelcomeNotificationOptions;
  /**
   * Bildirim tıklamasında açık sekme eşleştirme: `exact` (varsayılan) yalnızca aynı URL'deki sekmeyi,
   * `origin` aynı origin'deki herhangi bir sekmeyi kullanır. Eşleşme yoksa yeni pencere açılır.
   */
  notificationClickHandlerMatch?: 'exact' | 'origin';
  /** Eşleşen sekmede `navigate` (varsayılan) bildirim URL'sine gider, `focus` yalnızca sekmeyi öne getirir. */
  notificationClickHandlerAction?: 'navigate' | 'focus';
  /** İzin istemi ek ayarları: özel bağlantı ve geri çekilme takvimi. */
  promptOptions?: PromptOptions;
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
  /**
   * `preventDefault` ile engellenmiş bildirimi aynı içerikle sonradan gösterir (yalnızca bir kez).
   * Engellenmemiş bildirimi service worker zaten gösterir; bu durumda bir şey yapmaz.
   */
  display: () => Promise<void>;
}

/** `Notifications.addPermissionObserver` olayı. */
export interface PermissionChangeEvent {
  /** Bildirim izni verildi mi (diğer HeroSignal SDK'larıyla aynı alan). */
  permission: boolean;
  /** Ayrıntılı tarayıcı izin durumu. */
  state: PermissionState;
}

/** Cihazda saklanan SDK durumu. */
export interface PersistedState {
  subscriptionId: string | null;
  userId: string | null;
  externalId: string | null;
  /** Kimlik doğrulama (identity verification) hash'i; login ile verilir, logout ile silinir. */
  identityHash: string | null;
  /** Kimlik JWT'si (ES256; ADR-0023 §9); login veya updateUserJwt ile verilir, logout ile silinir. */
  identityJwt: string | null;
  tags: Record<string, string>;
  optedIn: boolean;
  consentGiven: boolean;
  tokenHash: string | null;
  /** Gerçek PushSubscription endpoint'i (`pushSubscription.token`). */
  pushEndpoint: string | null;
  slidedownDismissedAt: number | null;
  /** İzin isteminin (slidedown/otomatik native) kaç kez reddedildiği; geri çekilme takvimini belirler. */
  promptDismissCount: number;
  /** Karşılama bildiriminin gösterildiği abonelik kimliği (abonelik başına bir kez). */
  welcomeShownFor: string | null;
  pageViews: number;
  queue: QueuedOperation[];
  /** `User.addEmail`/`addSms` ile eklenen abonelikler (adres düz metin değil, SHA-256 özeti saklanır). */
  contactSubscriptions: ContactSubscription[];
  /** In-app sıklık için yerel gösterim kaydı (mesaj kimliği → kayıt). */
  inAppLocal: Record<string, InAppLocalRecord>;
  /** Herhangi bir in-app mesajın son gösterim anı (epoch ms); app geneli `in_app.min_interval_seconds` için. */
  inAppLastImpressionAt: number | null;
  /** E-posta/SMS toplama istemi kabul edildi (bir daha gösterilmez). */
  contactPromptAnswered: boolean;
  /** E-posta/SMS toplama isteminin son reddi ve ret sayısı (push istemiyle aynı geri çekilme takvimi). */
  contactPromptDismissedAt: number | null;
  contactPromptDismissCount: number;
  /** `Location.setShared`: konum paylaşımı açık mı (kalıcı; varsayılan kapalı). */
  locationShared: boolean;
  /** Son konum gönderiminin kuyruğa yazıldığı an (epoch ms); 5 dk aralık için. */
  locationSentAt: number | null;
  /** `Location.requestPermission` izin aldı (Permissions API olmayan tarayıcılarda istemsiz okuma için). */
  locationPermissionGranted: boolean;
  /**
   * Öğrenilen bölgesel API kökü (ADR-0032 §4; config `api_url` veya 421 `HS_WRONG_CELL`) ve öğrenildiği
   * başlangıç kökü. Başlangıç kökü (init `apiUrl`) değişirse kayıt kullanılmaz.
   */
  regionalApiUrl: string | null;
  regionalApiSeed: string | null;
}

// --- Kullanıcı tercihleri (ADR-0019 §4) ---

/** `GET /config` → `categories[]` ve tercih yanıtındaki kategori (ad/açıklama dil → metin). */
export interface PreferenceCategory {
  key: string;
  name: Record<string, string>;
  description: Record<string, string>;
  /** Kategorinin geçerli olduğu kanallar; null = tüm kanallar. */
  channels: string[] | null;
  defaultOptedIn: boolean;
}

export interface UserPreference {
  category: string;
  /** null = tüm kanallar. */
  channel: Channel | null;
  optedIn: boolean;
  /** Açık kayıt mı (false: kategori varsayılanından türetilmiş). */
  explicit: boolean;
  source: string | null;
  updatedAt: string | null;
}

/** `User.setPreferences` girdisi; `channel` verilmezse tüm kanallar. */
export interface PreferenceInput {
  category: string;
  optedIn: boolean;
  channel?: Channel | null;
}

export interface UserPreferences {
  preferences: UserPreference[];
  categories: PreferenceCategory[];
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

/**
 * Mesajın gösterim koşulu. Bir grup içindeki tüm koşullar aynı anda sağlanmalıdır (VE);
 * `trigger_groups` ile gruplar VEYA ile bağlanır (ADR-0019 §7).
 */
export type InAppTrigger =
  | { kind: 'session_start' }
  | { kind: 'event'; name: string }
  | { kind: 'screen'; name: string }
  | { kind: 'trigger'; key: string; op: InAppTriggerOperator; value?: string | number }
  /** Geçerli oturum en az bu kadar saniye sürdüyse sağlanır (zamanlayıcıyla yeniden değerlendirilir). */
  | { kind: 'session_duration'; seconds: number };

export type InAppAction =
  | { type: 'dismiss' }
  | { type: 'url'; url: string }
  | { type: 'deeplink'; url: string }
  | { type: 'tags'; tags: Record<string, string> }
  /** Yerel push izin istemini açar (`Notifications.requestPermission`), ardından mesaj kapanır. */
  | { type: 'push_prompt' }
  /** Olay (outcome) gönderir (`Session.sendEvent(name, undefined, value)`), ardından mesaj kapanır. */
  | { type: 'outcome'; name: string; value?: number };

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
    }
  /** Yatay kaydırmalı kartlar (ADR-0027); SDK `supports=carousel` bildirdiğinde gelir. */
  | { type: 'carousel'; id: string; cards: InAppCarouselCard[] };

/** Carousel kartı: görsel, başlık, metin ve isteğe bağlı düğme (metinler kullanıcının dilinde). */
export interface InAppCarouselCard {
  id: string;
  title: string;
  body: string | null;
  image_url: string | null;
  image_alt: string | null;
  button: { id: string; text: string; action: InAppAction } | null;
}

export type InAppLayout = 'modal' | 'banner_top' | 'banner_bottom' | 'fullscreen';

export interface InAppDisplay {
  layout: InAppLayout;
  background_color: string | null;
  text_color: string | null;
  dismissible: boolean;
  auto_dismiss_seconds: number | null;
  /** `html`: `html` sandbox'lı iframe'de çizilir (ADR-0027); yoksa `blocks` (eski sunucu). */
  content_type?: 'blocks' | 'html';
  html?: string | null;
  /** HTML içerik başlangıç yüksekliği (px); köprü `resize` ile güncellenir. */
  html_height?: number | null;
  blocks: InAppBlock[];
}

/** `GET /sdk/v1/apps/{appId}/in-app` öğesi (metinler kullanıcının dilinde çözülmüş). */
export interface InAppMessage {
  id: string;
  priority: number;
  /** Geriye uyum: ilk tetik grubu. */
  triggers: InAppTrigger[];
  /** Gruplar VEYA, grup içi VE; yoksa `[triggers]` kullanılır. */
  trigger_groups?: InAppTrigger[][];
  /** Sunucunun seçtiği görünüm varyantı; olaylarla geri gönderilir (A/B raporu). */
  variant_id?: string | null;
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
  | {
      type: 'event';
      name: string;
      properties?: Record<string, unknown>;
      value?: number;
      occurredAt: string;
      /** İstemci olay kimliği: yeniden denemede sunucu aynı olayı ikinci kez kaydetmez (eski kuyruk öğelerinde yok). */
      eventId?: string;
      at: number;
    }
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
      /** Mesajın gösterilen varyantı (A/B); sunucu `variant_id` döndürdüyse her olayda geri gider. */
      variantId?: string;
      at: number;
    }
  /** Kullanıcı tercihleri (`User.setPreferences`); gönderim anındaki abonelik kanıtıyla yazılır. */
  | { type: 'preferences'; preferences: PreferenceInput[]; at: number }
  /** Konum (`Location.setShared`): push aboneliğine PATCH edilir; `null` sunucudaki konumu ve rıza kaydını siler. */
  | { type: 'location'; location: LocationFix | null; at: number }
  /** Kuyruk flush'ında ardışık olaylardan oluşturulan toplu gönderim (kalıcı saklanmaz). */
  | { type: 'event_batch'; events: Extract<QueuedOperation, { type: 'event' }>[]; at: number };

/** Service worker → sayfa mesajları. */
export type WorkerMessage =
  | { type: 'hs:notification-click'; payload: WebPushPayload; actionId?: string; url?: string }
  | { type: 'hs:subscription-change'; subscription: PushSubscriptionJSON | null }
  | { type: 'hs:received'; deliveryId: string }
  | { type: 'hs:push-received'; payload: WebPushPayload };
