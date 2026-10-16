import {
  currentPermission,
  detectSiteIcon,
  isPushSupported,
  isSecureContextOk,
  subscriptionToToken,
  WebPushManager,
} from './browser/push.js';
import {
  DEFAULT_PROMPT_BACKOFF_DAYS,
  collectsContact,
  mountBell,
  customLinkFromRemote,
  promptBackoffElapsed,
  welcomeFromRemote,
  showLocationRationale,
  showSlidedown,
  slidedownFromRemote,
  waitForScrollPercent,
} from './browser/prompts.js';
import { currentPosition, geolocationPermission, isGeolocationSupported } from './browser/location.js';
import { renderCustomLinks } from './browser/custom-link.js';
import { welcomeNotification } from './browser/welcome.js';
import { InAppManager } from './browser/in-app.js';
import { SessionTracker } from './browser/session.js';
import {
  ApiError,
  categoryFromApi,
  deleteSubscription,
  fetchPreferences,
  ownershipProof,
  postInAppEvent,
  preferencesFromApi,
  putPreferences,
  registerContact,
  SdkApi,
  type InboxAuth,
  type PreferencesAuth,
  type RegisterResult,
  type SdkConfig,
  type UserResult,
} from './core/api.js';
import { acceptApiUrl, isExplicitApiUrl } from './core/cell.js';
import { normalizeContact } from './core/contact.js';
import { ErrorReporter } from './core/errors.js';
import { newEventId } from './core/event-id.js';
import { assertAliasLabel, normalizeAliases } from './core/identity.js';
import { InboxClient } from './core/inbox.js';
import { locationRefreshDue } from './core/location.js';
import { Logger } from './core/logger.js';
import { OfflineQueue } from './core/queue.js';
import { digest, syncPushToken } from './core/token.js';
import { deliveryIdOf, messageIdOf, toNotificationOptions } from './sw/payload.js';

/** `track()` olayları bu süre biriktirilip tek istekte gönderilir. */
const EVENT_FLUSH_DELAY_MS = 1000;
import { StateStore } from './core/storage.js';
import type {
  ContactChannel,
  DeviceInfo,
  ForegroundLifecycleEvent,
  InAppClickEvent,
  InAppLifecycleListener,
  InAppTriggerValue,
  InboxChangeEvent,
  InboxListOptions,
  InitOptions,
  LocationFix,
  LogLevel,
  NotificationClickEvent,
  PreferenceCategory,
  PreferenceInput,
  SlidedownCollect,
  SlidedownOptions,
  PermissionChangeEvent,
  PermissionState,
  PushSubscriptionState,
  QueuedOperation,
  UserPreferences,
  WebPushPayload,
  WorkerMessage,
} from './core/types.js';

const SDK_VERSION = typeof __HS_SDK_VERSION__ === 'string' ? __HS_SDK_VERSION__ : '0.0.0-dev';

type Listener<T> = (event: T) => void;

/** Pushizo Web SDK ana sınıfı (eski sağlayıcı v5 yüzeyiyle uyumlu). */
export class PushizoSdk {
  readonly version = SDK_VERSION;
  private readonly logger = new Logger();
  private options: InitOptions | null = null;
  private api: SdkApi | null = null;
  /** Başlangıç API kökü (init `apiUrl` veya SDK'nın yüklendiği origin); öğrenilen bölgesel kök buna bağlanır. */
  private apiSeed = '';
  private store: StateStore | null = null;
  private queue: OfflineQueue | null = null;
  private push: WebPushManager | null = null;
  private config: SdkConfig | null = null;
  private session: SessionTracker | null = null;
  private initPromise: Promise<void> | null = null;
  private language = 'en';
  private readonly clickListeners = new Set<Listener<NotificationClickEvent>>();
  private readonly foregroundListeners = new Set<Listener<ForegroundLifecycleEvent>>();
  private readonly subscriptionObservers = new Set<Listener<PushSubscriptionState>>();
  private readonly permissionObservers = new Set<Listener<PermissionChangeEvent>>();
  /** Gözlemcilere son bildirilen izin durumu (değişim tespiti için). */
  private lastPermission: PermissionState | null = null;
  private permissionWatchInstalled = false;
  /** `start()` bir kez çalışır (onay geri alınıp yeniden verilse de dinleyiciler çoğalmaz). */
  private started = false;
  private unmountBell: (() => void) | null = null;
  private errors: ErrorReporter | null = null;
  /** Son bildirilen kullanıcı/abonelik anahtarı (değişince in-app listesi ve inbox önbelleği yenilenir). */
  private identityKey = '';
  private readonly inApp = new InAppManager({
    api: () => this.api,
    store: () => this.store,
    logger: this.logger,
    language: () => this.language,
    subscriptionId: () => this.primarySubscriptionId(),
    ownershipHash: (subscriptionId) => this.ownershipHashOf(subscriptionId),
    enqueue: (op) => this.enqueue(op),
    addTags: (tags) => this.User.addTags(tags),
    // `push_prompt`: mevcut izin + abonelik akışı; `outcome`: mevcut olay API'si.
    requestPushPermission: () => this.Notifications.requestPermission(),
    sendOutcome: (name, value) => this.Session.sendEvent(name, undefined, value),
    sendEvent: (name, properties) => this.Session.sendEvent(name, properties),
    globalMinIntervalSeconds: () => this.config?.in_app?.min_interval_seconds ?? 0,
    reportError: (code, message, err) => this.reportError(code, message, err),
  });
  private readonly inbox = new InboxClient({
    api: () => this.api,
    auth: () => this.inboxAuth(),
    logger: this.logger,
  });

  // --- Yaşam döngüsü ---

  async init(options: InitOptions): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit(options);
    return this.initPromise;
  }

  private async doInit(options: InitOptions): Promise<void> {
    if (!options.appId) throw new Error('Pushizo.init: appId gerekli.');
    this.options = options;
    if (options.logLevel) this.logger.setLevel(options.logLevel);
    this.language =
      options.language ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
    const seed = (options.apiUrl ?? inferApiUrl()).replace(/\/$/, '');
    this.apiSeed = seed;
    this.store = new StateStore(options.appId);
    const saved = this.store.get();
    // Daha önce öğrenilen bölgesel kök, aynı başlangıç kökü için kullanılır (ADR-0032 §4).
    const regional =
      saved.regionalApiSeed === seed ? acceptApiUrl(saved.regionalApiUrl, seed) : null;
    this.api = new SdkApi({
      baseUrl: regional ?? seed,
      appId: options.appId,
      logger: this.logger,
      identityToken: () => this.store?.get().identityJwt ?? null,
      onBaseUrlChange: (url) => this.store?.update({ regionalApiUrl: url, regionalApiSeed: seed }),
      // Son savunma hattı: gizlilik onayı yokken hiçbir yoldan ağ isteği çıkmaz (KVKK/GDPR, plan 06 §6.1).
      fetch: (input, init) =>
        this.consentPending()
          ? Promise.reject(new ApiError(0, 'NO_CONSENT', 'gizlilik onayı verilmedi'))
          : fetch(input, init),
    });
    const api = this.api;
    this.errors = new ErrorReporter({
      sdkVersion: SDK_VERSION,
      send: (body) => api.request('POST', '/errors', body),
    });
    this.queue = new OfflineQueue(this.store, (op) => this.perform(op), this.logger, {
      onRejected: (op, err) =>
        this.reportError('operation_rejected', 'kuyruk işlemi sunucu tarafından reddedildi', err, {
          operation: op.type,
        }),
      // Onay verilene kadar işlemler kuyrukta (kalıcı) bekler; `setConsentGiven(true)` ile gönderilir.
      isPaused: () => this.consentPending(),
    });
    this.store.update({ pageViews: this.store.get().pageViews + 1 });

    if (this.consentPending()) {
      this.errors.setEnabled(false);
      this.logger.info('gizlilik onayı bekleniyor; ağ çağrısı yapılmayacak');
      return;
    }
    await this.start();
  }

  /** SDK iç hatasını toplu hata raporuna ekler (en iyi çaba; ağ hataları ve tekrarlar atlanır). */
  private reportError(
    code: string,
    message: string,
    err?: unknown,
    context?: Record<string, string | number | boolean | null>,
  ): void {
    this.errors?.record(code, message, err, {
      subscriptionId: this.store?.get().subscriptionId,
      context,
    });
  }

  /** `requiresPrivacyConsent` açık ve onay henüz verilmemiş mi (true iken ağ çağrısı yapılmaz). */
  private consentPending(): boolean {
    return this.options?.requiresPrivacyConsent === true && this.store?.get().consentGiven !== true;
  }

  /** KVKK/GDPR onayı: verilince SDK başlar ve onay öncesi kuyruğa alınan işlemler gönderilir. */
  async setConsentGiven(given: boolean): Promise<void> {
    if (!this.store) throw new Error('Pushizo.init önce çağrılmalı.');
    this.store.update({ consentGiven: given });
    this.errors?.setEnabled(given);
    if (given) {
      if (this.api && !this.started) await this.start();
      else await this.queue?.flush();
      return;
    }
    this.queue?.clear();
    const { pageViews, regionalApiUrl, regionalApiSeed } = this.store.get();
    // Bölgesel API kökü kişisel veri değildir; onay geri alınsa da yönlendirme bilgisi korunur.
    this.store.reset({ consentGiven: false, pageViews, regionalApiUrl, regionalApiSeed });
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const options = this.options!;
    // Yapılandırma önce alınır: service worker yolu/kapsamı ve istem ayarları dashboard'dan gelebilir.
    try {
      this.config = await this.api!.request<SdkConfig>('GET', '/config');
      this.adoptRegionalApiUrl(this.config.api_url);
    } catch (err) {
      this.logger.error('app yapılandırması alınamadı', err);
      this.reportError('config_failed', 'app yapılandırması alınamadı', err);
    }

    if (!isPushSupported()) {
      this.logger.warn('bu tarayıcı Web Push desteklemiyor');
    } else if (!isSecureContextOk(options.allowLocalhostAsSecureOrigin ?? false)) {
      this.logger.warn('Web Push yalnızca HTTPS (veya localhost) üzerinde çalışır');
    } else {
      this.push = new WebPushManager({
        appId: options.appId,
        apiUrl: this.api!.appBase.replace(/\/sdk\/v1\/apps\/.*$/, ''),
        // Yerel init seçenekleri önceliklidir; yoksa dashboard ayarı, o da yoksa varsayılan.
        serviceWorkerPath:
          options.serviceWorkerPath ??
          this.config?.web.service_worker_path ??
          '/PushizoSDKWorker.js',
        serviceWorkerScope:
          options.serviceWorkerScope ?? this.config?.web.service_worker_scope ?? undefined,
        clickMatch: options.notificationClickHandlerMatch ?? this.config?.web.click_behavior?.match,
        clickAction: options.notificationClickHandlerAction ?? this.config?.web.click_behavior?.action,
        logger: this.logger,
      });
      this.push.onMessage((message, reply) => this.handleWorkerMessage(message, reply));
    }

    // Mevcut aboneliği sunucuyla eşitle (token yenileme / ilk kayıt)
    if (this.push && this.config?.web.vapid_public_key) {
      await this.syncExistingSubscription().catch((err: unknown) => {
        this.logger.warn('abonelik eşitlenemedi', err);
        this.reportError('subscription_sync_failed', 'push aboneliği eşitlenemedi', err);
      });
    }

    // In-app mesajlar oturum başında listeyi alır; abonelik (push veya e-posta/SMS) yoksa beklemede kalır.
    this.inApp.start();
    this.identityKey = this.currentIdentityKey();

    // Oturum takibi
    this.session = new SessionTracker(
      () => {
        this.enqueue({ type: 'session_start', at: Date.now() });
        this.inApp.onSessionStart();
      },
      (duration) => {
        this.inApp.onSessionEnd();
        this.sendSessionEnd(duration);
      },
      this.config?.session.timeout_seconds ?? 30,
    );
    this.session.attach();

    window.addEventListener('online', () => void this.queue!.flush());
    // Sayfa gizlenirken biriken olaylar gönderilir; ön plana dönüşte konum (paylaşım açıksa, 5 dk aralıkla) yenilenir.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.queue?.flush();
      else void this.refreshLocation();
    });
    await this.queue!.flush();
    // Oturum başlangıcında konum (yalnızca paylaşım açık ve izin zaten verilmişse).
    void this.refreshLocation();

    if (options.bell?.enabled) {
      this.unmountBell = mountBell(
        options.bell,
        this.language,
        () => this.User.pushSubscription.optedIn,
        () => void this.toggleBell(),
      );
    }
    this.renderCustomLinks();
    // Yerel `autoPrompt`/`slidedown` seçenekleri önceliklidir; verilmemişse dashboard istemi kullanılır.
    const remotePrompt = this.config?.web.prompt;
    if (options.autoPrompt) void this.maybeShowSlidedown({ pageViews: 1 }, 'native');
    else if (options.slidedown) {
      if (options.slidedown.enabled !== false) void this.maybeShowSlidedown(options.slidedown);
    } else if (remotePrompt?.enabled) {
      void this.maybeShowSlidedown(
        slidedownFromRemote(remotePrompt, this.language),
        remotePrompt.type === 'native' ? 'native' : 'slidedown',
      );
    }
  }

  /**
   * Config `api_url`: init'te `apiUrl` verilmediyse (veya global varsayılan köke eşitse) app'in bölgesel API kökü
   * benimsenir ve saklanır. Özel `apiUrl` geliştiricinin kararıdır (kendi alan adı/vekil sunucu) ve korunur.
   */
  private adoptRegionalApiUrl(candidate: unknown): void {
    if (isExplicitApiUrl(this.options!.apiUrl) || !this.api) return;
    const next = acceptApiUrl(candidate, this.api.baseUrl);
    if (!next || next === this.api.baseUrl) return;
    this.logger.info('bölgesel API kökü kullanılıyor', next);
    this.api.setBaseUrl(next);
    this.store!.update({
      regionalApiUrl: next,
      regionalApiSeed: this.apiSeed,
    });
  }

  private async syncExistingSubscription(): Promise<void> {
    const pending = await this.push!.takePendingSubscriptionChange();
    const browserSub =
      pending === undefined ? await this.push!.getSubscription() : pending ? null : null;
    const state = this.store!.get();
    if (pending) {
      await this.registerToken(pending);
      return;
    }
    if (browserSub) {
      // Token değiştiyse mevcut abonelik PATCH ile güncellenir (syncPushToken).
      await this.registerToken(browserSub.toJSON());
    } else if ((this.options!.autoResubscribe ?? true) && currentPermission() === 'granted') {
      // İzin verilmiş ama tarayıcı aboneliği yok (ilk ziyaret veya SW temizlenmiş): otomatik abone ol.
      // Kullanıcı bilinçli olarak opt-out yaptıysa (kayıt var, optedIn=false) dokunulmaz.
      if (!state.subscriptionId || state.optedIn) await this.subscribeNow();
    }
  }

  // --- Kayıt ---

  /**
   * Gerçek bir PushSubscription'ı sunucuyla eşitler: kayıt yoksa oluşturur, token değiştiyse mevcut
   * aboneliği günceller. Endpoint/anahtar eksikse hiçbir şey gönderilmez.
   * @returns Abonelik sunucuda kayıtlıysa true.
   */
  private async registerToken(
    subscription: PushSubscriptionJSON,
    user?: { external_id?: string; identity_hash?: string },
  ): Promise<boolean> {
    const token = subscriptionToToken(subscription);
    if (!token) {
      this.logger.warn('geçerli bir push aboneliği yok; token gönderilmedi');
      this.reportError(
        'invalid_subscription',
        'tarayıcı aboneliğinde endpoint/anahtar yok',
        undefined,
      );
      return false;
    }
    const result = await syncPushToken(this.api!, this.store!, {
      token,
      endpoint: subscription.endpoint ?? null,
      device: this.deviceInfo(),
      user,
    });
    if (result === 'created') void this.showWelcomeNotification();
    if (result !== 'unchanged') this.notifySubscription();
    return true;
  }

  /** İlk abonelikten sonra yerel karşılama bildirimi; abonelik başına bir kez (eski sağlayıcı davranışı). */
  private async showWelcomeNotification(): Promise<void> {
    const subscriptionId = this.store!.get().subscriptionId;
    if (!this.push || !subscriptionId || this.store!.get().welcomeShownFor === subscriptionId) return;
    const remoteWelcome = this.config?.web.welcome_notification;
    const welcome = welcomeNotification(
      this.options!.welcomeNotification ?? (remoteWelcome ? welcomeFromRemote(remoteWelcome, this.language) : undefined),
      this.language,
      document.title,
      window.location.origin,
    );
    if (!welcome) return;
    this.store!.update({ welcomeShownFor: subscriptionId });
    try {
      await this.push.showLocalNotification(welcome.title, welcome.options);
    } catch (err) {
      this.logger.warn('karşılama bildirimi gösterilemedi', err);
      this.reportError('welcome_failed', 'karşılama bildirimi gösterilemedi', err);
    }
  }

  /** Özel bağlantı istemini (`promptOptions.customlink`) sayfadaki kapsayıcılara çizer. */
  private renderCustomLinks(): void {
    const remoteCustom = this.config?.web.custom_link;
    const custom =
      this.options?.promptOptions?.customlink ?? (remoteCustom ? customLinkFromRemote(remoteCustom, this.language) : undefined);
    if (!custom?.enabled || typeof document === 'undefined' || !this.store) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.renderCustomLinks(), { once: true });
      return;
    }
    renderCustomLinks(custom, this.language, this.User.pushSubscription.optedIn, () =>
      (this.User.pushSubscription.optedIn
        ? this.User.pushSubscription.optOut()
        : this.User.pushSubscription.optIn()
      ).catch((err: unknown) => this.logger.warn('özel bağlantı işlemi başarısız', err)),
    );
  }

  private async subscribeNow(): Promise<void> {
    if (!this.push) return;
    if (!this.config?.web.vapid_public_key) {
      this.logger.error(
        'Web Push kanalı yapılandırılmamış (VAPID anahtarı yok). Dashboard → Kanallar → Web Push.',
      );
      return;
    }
    const sub = await this.push.subscribe(this.config.web.vapid_public_key);
    if (!(await this.registerToken(sub.toJSON()))) return;
    if (this.store!.get().subscriptionId && !this.store!.get().optedIn) {
      await this.api!.request('PATCH', `/subscriptions/${this.store!.get().subscriptionId}`, {
        opted_in: true,
        ...ownershipProof(this.store!.get().tokenHash),
      });
      this.store!.update({ optedIn: true });
      this.notifySubscription();
    }
    await this.queue!.flush();
  }

  /** Sitenin sürümü (`<meta name="hs-app-version">`), yoksa undefined. */
  private appVersion(): string | undefined {
    if (typeof document === 'undefined') return undefined;
    // Boş değer de "bilinmiyor" sayılır: alan null/boş gönderilmez, hiç gönderilmez.
    return (
      document.querySelector('meta[name="hs-app-version"]')?.getAttribute('content')?.trim() ||
      undefined
    );
  }

  private deviceInfo(): DeviceInfo {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const appVersion = this.appVersion();
    return {
      model: browserName(ua),
      os: osName(ua),
      sdk_version: SDK_VERSION,
      sdk_platform: 'web',
      locale: this.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      push_capable: isPushSupported() && currentPermission() === 'granted',
      ...(appVersion ? { app_version: appVersion } : {}),
    };
  }

  /** `POST /sessions` gövdesi (başlangıç: süresiz; bitiş: `duration_seconds`); sahiplik kanıtı eklenir. */
  private sessionBody(durationSeconds?: number): Record<string, unknown> | null {
    const state = this.store!.get();
    if (!state.subscriptionId) return null;
    // Oturumda sürüm bilgisi de güncellenir (docs/plan/06 "Token yaşam döngüsü").
    const appVersion = this.appVersion();
    return {
      subscription_id: state.subscriptionId,
      ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
      sdk_version: SDK_VERSION,
      ...(appVersion ? { app_version: appVersion } : {}),
      ...ownershipProof(state.tokenHash, state.identityHash),
    };
  }

  /**
   * Oturum bitişi (`pagehide` / zaman aşımı): sayfa kapanırken kuyruk sırasını beklemeden doğrudan
   * `keepalive` fetch ile gönderilir (ADR-0019 §8; istek pagehide içinde eşzamanlı başlatılır).
   * Geçici hatada işlem kuyruğa yazılır ve sonraki açılışta yeniden denenir.
   */
  private sendSessionEnd(durationSeconds: number): void {
    const body = this.sessionBody(durationSeconds);
    if (!body || !this.api || this.consentPending()) return;
    this.api.request('POST', '/sessions', body).catch((err: unknown) => {
      if (err instanceof ApiError && !err.retryable) {
        this.reportError('operation_rejected', 'oturum bitişi sunucu tarafından reddedildi', err, {
          operation: 'session_end',
        });
        return;
      }
      this.logger.debug('oturum bitişi gönderilemedi, kuyruğa alındı', err);
      this.queue?.enqueue({ type: 'session_end', durationSeconds, at: Date.now() });
    });
  }

  /** Verilen aboneliğin tercih/oturum uçları için sahiplik kanıtı (push: token özeti, e-posta/SMS: adres özeti). */
  private preferencesAuth(): PreferencesAuth | null {
    const subscriptionId = this.primarySubscriptionId();
    if (!subscriptionId) return null;
    const state = this.store!.get();
    return {
      subscription_id: subscriptionId,
      ...ownershipProof(this.ownershipHashOf(subscriptionId), state.identityHash),
    };
  }

  // --- Kuyruk işlemleri ---

  private eventFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Olaylar kısa süre biriktirilip toplu gönderilir; diğer işlemler (ve bekleyen olaylar) hemen gönderilir. */
  private enqueue(op: QueuedOperation): void {
    if (!this.queue) return;
    this.queue.enqueue(op);
    if (op.type === 'event') {
      if (this.eventFlushTimer) return;
      this.eventFlushTimer = setTimeout(() => {
        this.eventFlushTimer = null;
        void this.queue?.flush();
      }, EVENT_FLUSH_DELAY_MS);
      return;
    }
    void this.queue.flush();
  }

  private async perform(op: QueuedOperation): Promise<void> {
    const state = this.store!.get();
    switch (op.type) {
      case 'tags':
      case 'properties': {
        if (!state.userId) await this.ensureUser();
        const userId = this.store!.get().userId;
        if (!userId) throw new ApiError(0, 'NO_USER', 'kullanıcı yok');
        const identityHash = this.store!.get().identityHash;
        const result = await this.api!.request<UserResult>('PATCH', `/users/${userId}`, {
          ...(op.type === 'tags' ? { tags: op.tags } : { properties: op.properties }),
          ...(identityHash ? { identity_hash: identityHash } : {}),
        });
        this.store!.update({ tags: result.tags });
        return;
      }
      case 'event':
      case 'event_batch': {
        const owner = this.eventOwner();
        // Bağlanacak kimlik yok: olay atılmaz, abonelik veya login gelene kadar kuyrukta bekler (B-16).
        if (!owner) throw new ApiError(0, 'NO_IDENTITY', 'olayın bağlanacağı abonelik veya external_id yok');
        const ops = op.type === 'event' ? [op] : op.events;
        await this.api!.request('POST', '/events', {
          events: ops.map((e) => ({
            name: e.name,
            properties: e.properties ?? {},
            value: e.value,
            occurred_at: e.occurredAt,
            event_id: e.eventId,
            ...owner,
          })),
        });
        return;
      }
      case 'session_start':
      case 'session_end': {
        const body = this.sessionBody(op.type === 'session_end' ? op.durationSeconds : undefined);
        if (!body) return;
        await this.api!.request('POST', '/sessions', body);
        return;
      }
      case 'preferences': {
        // Tag/property işlemleriyle aynı kural: abonelik yoksa oluşturulmaya çalışılır, olmazsa yeniden denenir.
        if (!this.primarySubscriptionId()) await this.ensureUser();
        const auth = this.preferencesAuth();
        if (!auth) throw new ApiError(0, 'NO_SUBSCRIPTION', 'abonelik yok');
        await putPreferences(this.api!, auth, op.preferences);
        return;
      }
      case 'alias_add': {
        const identity =
          op.aliases ?? (op.label && op.value ? { [op.label]: op.value } : undefined);
        if (!identity || Object.keys(identity).length === 0) return;
        const userId = await this.requireUserId();
        const identityHash = this.store!.get().identityHash;
        await this.api!.request('PATCH', `/users/${userId}/identity`, {
          identity,
          ...(identityHash ? { identity_hash: identityHash } : {}),
        });
        return;
      }
      case 'alias_remove': {
        const userId = await this.requireUserId();
        const identityHash = this.store!.get().identityHash;
        const query = identityHash ? `?identity_hash=${encodeURIComponent(identityHash)}` : '';
        await this.api!.request(
          'DELETE',
          `/users/${userId}/identity/${encodeURIComponent(op.label)}${query}`,
        );
        return;
      }
      case 'received':
        await this.api!.request('POST', `/deliveries/${op.deliveryId}/received`, {});
        return;
      case 'opened':
        await this.api!.request(
          'POST',
          `/deliveries/${op.deliveryId}/opened`,
          op.buttonId ? { button_id: op.buttonId } : {},
        );
        return;
      case 'location': {
        const subscriptionId = state.subscriptionId;
        if (!subscriptionId) {
          // Kayıtlı push aboneliği yoksa sunucuda silinecek konum da yoktur; konum ise abonelik oluşana kadar bekler.
          if (op.location === null) return;
          throw new ApiError(0, 'NO_SUBSCRIPTION', 'push aboneliği yok');
        }
        // `opted_in` güncellemesiyle aynı sahiplik kanıtı; JWT başlıkta gider. `null`: konum ve rıza kaydı silinir.
        await this.api!.request('PATCH', `/subscriptions/${subscriptionId}`, {
          location: op.location,
          ...ownershipProof(state.tokenHash),
        });
        return;
      }
      case 'contact_add':
        await this.addContactNow(op.channel, op.token);
        return;
      case 'contact_remove':
        await this.removeContactNow(op.channel, op.token);
        return;
      case 'in_app_event': {
        try {
          await postInAppEvent(this.api!, op.messageId, {
            subscription_id: op.subscriptionId,
            // Kanıt gönderim anında çözülür (kuyrukta saklanmaz); abonelik bu cihazda değilse eklenmez.
            ...ownershipProof(this.ownershipHashOf(op.subscriptionId)),
            type: op.eventType,
            ...(op.buttonId ? { button_id: op.buttonId } : {}),
            ...(op.variantId ? { variant_id: op.variantId } : {}),
          });
        } catch (err) {
          // Kalıcı ret: kuyruk işlemi atar; yerel bekleyen gösterim de düşülür.
          if (op.eventType === 'impression' && err instanceof ApiError && !err.retryable)
            this.inApp.acknowledgeImpression(op.messageId);
          throw err;
        }
        if (op.eventType === 'impression') this.inApp.acknowledgeImpression(op.messageId);
        return;
      }
    }
  }

  // --- Konum (v2 Faz 17b) ---

  private locationInFlight = false;

  /**
   * Paylaşım açık, sayfa ön planda, gizlilik onayı verilmiş ve konum izni zaten varsa konumu alıp kuyruğa yazar
   * (en sık 5 dakikada bir; `force` aralığı atlar). İzin yoksa istem gösterilmez, hiçbir şey gönderilmez.
   */
  private async refreshLocation(force = false): Promise<void> {
    const store = this.store;
    if (!store || !this.started || this.consentPending() || this.locationInFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const state = store.get();
    if (!locationRefreshDue(state.locationShared, state.locationSentAt, Date.now(), force)) return;
    this.locationInFlight = true;
    try {
      const permission = await geolocationPermission();
      if (permission === 'denied') store.update({ locationPermissionGranted: false });
      // Permissions API yoksa yalnızca daha önce `requestPermission` ile izin alındıysa okunur (istem açılmasın).
      if (permission !== 'granted' && !(permission === 'unknown' && store.get().locationPermissionGranted)) return;
      const result = await currentPosition();
      if (result.kind === 'denied') store.update({ locationPermissionGranted: false });
      if (result.kind === 'fix') this.sendLocation(result.fix);
    } catch (err) {
      this.logger.debug('konum alınamadı', err);
    } finally {
      this.locationInFlight = false;
    }
  }

  /** Konumu kuyruğa yazar; beklerken paylaşım kapatıldıysa veya onay geri çekildiyse gönderilmez. */
  private sendLocation(fix: LocationFix): void {
    if (!this.store?.get().locationShared || this.consentPending()) return;
    this.store.update({ locationSentAt: Date.now() });
    this.enqueue({ type: 'location', location: fix, at: Date.now() });
  }

  // --- E-posta / SMS abonelikleri ---

  /** E-posta/SMS aboneliğinde gönderilen cihaz bilgisi (adresin eklendiği SDK). */
  private contactDevice(): DeviceInfo {
    return {
      sdk_version: SDK_VERSION,
      sdk_platform: 'web',
      locale: this.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  /** Adresi kaydeder; giriş yapılmışsa abonelik external_id ile kullanıcıya bağlanır. */
  private async addContactNow(channel: ContactChannel, token: string): Promise<void> {
    const state = this.store!.get();
    // Login yoksa adres bu cihazın (anonim) kullanıcısına, mevcut aboneliği üzerinden bağlanır.
    const deviceSubscriptionId = state.externalId ? null : this.primarySubscriptionId();
    const register = (user: {
      external_id?: string;
      identity_hash?: string;
      subscription_id?: string;
      token_hash?: string;
    }) => registerContact(this.api!, { channel, token, device: this.contactDevice(), user });
    let result: RegisterResult;
    if (state.externalId) {
      result = await register({
        external_id: state.externalId,
        ...(state.identityHash ? { identity_hash: state.identityHash } : {}),
      });
    } else if (deviceSubscriptionId) {
      try {
        // Bağlanan aboneliğin sahiplik kanıtı (ADR-0016).
        const proof = ownershipProof(this.ownershipHashOf(deviceSubscriptionId)).token_hash;
        result = await register({
          subscription_id: deviceSubscriptionId,
          ...(proof ? { token_hash: proof } : {}),
        });
      } catch (err) {
        // Cihaz aboneliği sunucuda yoksa adres yine kaydedilir (ayrı anonim kullanıcıyla).
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        result = await register({});
      }
    } else {
      result = await register({});
    }
    const tokenHash = await digest(`${channel}:${token}`);
    // Sunucudaki token_hash ile aynı özet (login/bağlama kanıtı); özet üretilemiyorsa adres saklanmaz.
    const ownershipHash = ownershipProof(await digest(token)).token_hash;
    const current = this.store!.get();
    this.store!.update({
      contactSubscriptions: [
        ...current.contactSubscriptions.filter(
          (c) => !(c.channel === channel && c.tokenHash === tokenHash),
        ),
        {
          channel,
          tokenHash,
          subscriptionId: result.subscription_id,
          userId: result.user_id,
          externalId: result.external_id,
          ...(ownershipHash ? { ownershipHash } : {}),
        },
      ],
      // Push aboneliği yoksa kullanıcı bu abonelikten gelir (tag/inbox için).
      ...(current.userId ? {} : { userId: result.user_id, externalId: result.external_id }),
    });
    this.syncIdentity();
  }

  private async removeContactNow(channel: ContactChannel, token: string): Promise<void> {
    const tokenHash = await digest(`${channel}:${token}`);
    const entry = this.store!.get().contactSubscriptions.find(
      (c) => c.channel === channel && c.tokenHash === tokenHash,
    );
    if (!entry) {
      this.logger.warn(`kaldırılacak ${channel} aboneliği bu cihazda kayıtlı değil`);
      return;
    }
    // Kanıt: kanonik adresin özeti; adres giriş yapmış kullanıcıya bağlıysa identity_hash de (doğrulama zorunlu app'ler).
    const state = this.store!.get();
    const identityHash =
      entry.externalId !== null && entry.externalId === state.externalId ? state.identityHash : null;
    try {
      await deleteSubscription(
        this.api!,
        entry.subscriptionId,
        ownershipProof(await digest(token), identityHash),
      );
    } catch (err) {
      // Sunucuda zaten yoksa yerel kayıt yine silinir.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    this.store!.update({
      contactSubscriptions: this.store!.get().contactSubscriptions.filter(
        (c) => c.subscriptionId !== entry.subscriptionId,
      ),
    });
    this.syncIdentity();
  }

  /** Login sonrası bu cihazda eklenen e-posta/SMS abonelikleri de aynı kullanıcıya bağlanır. */
  private async linkContacts(
    externalId: string,
    identityHash: string | undefined,
    moved: { fromUserId: string; result: UserResult } | null,
  ): Promise<void> {
    const contacts = this.store!.get().contactSubscriptions;
    if (contacts.length === 0) return;
    const linked: typeof contacts = [];
    for (const contact of contacts) {
      if (contact.externalId === externalId) {
        linked.push(contact);
        continue;
      }
      // Cihaz aboneliğiyle aynı anonim kullanıcıdaydı: login ile birlikte taşındı.
      if (moved && contact.userId === moved.fromUserId) {
        linked.push({
          ...contact,
          userId: moved.result.user_id,
          externalId: moved.result.external_id,
        });
        continue;
      }
      try {
        const result = await this.api!.request<UserResult>(
          'POST',
          `/subscriptions/${encodeURIComponent(contact.subscriptionId)}/login`,
          { external_id: externalId, identity_hash: identityHash, ...ownershipProof(contact.ownershipHash) },
        );
        linked.push({ ...contact, userId: result.user_id, externalId: result.external_id });
        // Push aboneliği yoksa cihazın kullanıcısı artık kimlikli kullanıcıdır.
        if (!this.store!.get().subscriptionId)
          this.store!.update({ userId: result.user_id, tags: result.tags });
      } catch (err) {
        // Abonelik sunucuda silinmiş: yerel kayıttan düşülür.
        if (err instanceof ApiError && err.status === 404) continue;
        this.logger.warn(`${contact.channel} aboneliği kullanıcıya bağlanamadı`, err);
        this.reportError(
          'contact_login_failed',
          'e-posta/SMS aboneliği kullanıcıya bağlanamadı',
          err,
          { channel: contact.channel },
        );
        linked.push(contact);
      }
    }
    this.store!.update({ contactSubscriptions: linked });
  }

  /**
   * Olayın bağlanacağı kimlik ve sahiplik kanıtı (D-1): push aboneliği, yoksa login'deki external_id, o da yoksa
   * bu cihazda eklenen e-posta/SMS aboneliği. `token_hash` aboneliğin kayıtlı kanonik token özeti, `identity_hash`
   * login'de verilen HMAC'tir; yalnızca mevcutsa eklenir.
   */
  private eventOwner(): Record<string, string> | null {
    const state = this.store!.get();
    const subscriptionId = state.subscriptionId ?? (state.externalId ? null : this.primarySubscriptionId());
    const identity = state.externalId ? ownershipProof(null, state.identityHash) : {};
    if (subscriptionId)
      return {
        subscription_id: subscriptionId,
        ...ownershipProof(this.ownershipHashOf(subscriptionId)),
        ...identity,
      };
    if (state.externalId) return { external_id: state.externalId, ...identity };
    return null;
  }

  /** Bu cihazdaki aboneliğin sahiplik kanıtı özeti (push: kayıtlı token, e-posta/SMS: kanonik adres). */
  private ownershipHashOf(subscriptionId: string): string | null {
    const state = this.store!.get();
    if (subscriptionId === state.subscriptionId) return state.tokenHash;
    return state.contactSubscriptions.find((c) => c.subscriptionId === subscriptionId)?.ownershipHash ?? null;
  }

  // --- In-app / inbox kimliği ---

  /** In-app için abonelik: push, yoksa kullanıcının e-posta/SMS aboneliği. */
  private primarySubscriptionId(): string | null {
    const state = this.store?.get();
    if (!state) return null;
    if (state.subscriptionId) return state.subscriptionId;
    const contact =
      state.contactSubscriptions.find((c) => c.userId === state.userId) ??
      state.contactSubscriptions[0];
    return contact?.subscriptionId ?? null;
  }

  /** Inbox uçları: abonelik kullanıcıya ait olmalı (sunucu doğrular). */
  private inboxAuth(): InboxAuth | null {
    const state = this.store?.get();
    if (!state?.userId) return null;
    const subscriptionId =
      state.subscriptionId ??
      state.contactSubscriptions.find((c) => c.userId === state.userId)?.subscriptionId;
    if (!subscriptionId) return null;
    return {
      userId: state.userId,
      subscriptionId,
      identityHash: state.identityHash,
      tokenHash: this.ownershipHashOf(subscriptionId),
    };
  }

  private currentIdentityKey(): string {
    return `${this.store?.get().userId ?? ''}|${this.primarySubscriptionId() ?? ''}`;
  }

  /** Kullanıcı/abonelik değiştiyse in-app listesi yenilenir ve inbox önbelleği temizlenir. */
  private syncIdentity(): void {
    const key = this.currentIdentityKey();
    if (key === this.identityKey) return;
    this.identityKey = key;
    this.inbox.reset();
    this.inApp.onIdentityChanged();
  }

  /** Kullanıcı kimliği; yoksa abonelik oluşturmayı dener, olmazsa yeniden denenebilir hata fırlatır. */
  private async requireUserId(): Promise<string> {
    if (!this.store!.get().userId) await this.ensureUser();
    const userId = this.store!.get().userId;
    if (!userId) throw new ApiError(0, 'NO_USER', 'kullanıcı yok');
    return userId;
  }

  /** Henüz abonelik yoksa tag/olay kaydı için anonim kullanıcı gerekir: abonelik olmadan kullanıcı oluşturamayız. */
  private async ensureUser(): Promise<void> {
    if (this.store!.get().userId) return;
    if (currentPermission() === 'granted') await this.subscribeNow();
  }

  // --- Worker mesajları ---

  private handleWorkerMessage(message: WorkerMessage, reply: (data: unknown) => void): void {
    switch (message.type) {
      case 'hs:push-received': {
        let prevented = false;
        let displayed = false;
        const payload = message.payload;
        const event: ForegroundLifecycleEvent = {
          notification: {
            title: message.payload.title ?? '',
            body: message.payload.body ?? '',
            deliveryId: deliveryIdOf(message.payload.hs),
            messageId: messageIdOf(message.payload.hs),
            data: message.payload.data ?? message.payload.hs ?? {},
          },
          preventDefault: () => {
            prevented = true;
          },
          // Engellenmiş bildirim sonradan aynı payload ile gösterilir (tıklama/`opened` SW'de aynen çalışır).
          // Engellenmediyse SW zaten gösterir; ikinci kez gösterilmez.
          display: async () => {
            if (!prevented || displayed || !this.push) return;
            displayed = true;
            const { title, options } = toNotificationOptions(payload, detectSiteIcon(document));
            await this.push.showLocalNotification(title, options);
          },
        };
        if (document.visibilityState === 'visible')
          for (const l of this.foregroundListeners) l(event);
        reply({ preventDefault: prevented });
        return;
      }
      case 'hs:notification-click': {
        const p: WebPushPayload = message.payload;
        const event: NotificationClickEvent = {
          notification: {
            title: p.title ?? '',
            body: p.body ?? '',
            url: p.url,
            deliveryId: deliveryIdOf(p.hs),
            messageId: messageIdOf(p.hs),
            data: p.data ?? p.hs ?? {},
          },
          result: { actionId: message.actionId, url: message.url },
        };
        for (const l of this.clickListeners) l(event);
        return;
      }
      case 'hs:subscription-change':
        // Tarayıcı aboneliği yeniledi: mevcut abonelik PATCH ile yeni token'a taşınır.
        if (message.subscription)
          void this.registerToken(message.subscription).catch((err: unknown) => {
            this.logger.warn('yenilenen abonelik eşitlenemedi', err);
            this.reportError('token_refresh_failed', 'yenilenen push token eşitlenemedi', err);
          });
        else this.store?.update({ optedIn: false });
        this.notifySubscription();
        return;
      case 'hs:received':
        return;
    }
  }

  /** İzin durumu değiştiyse izin gözlemcilerine bildirir. */
  private checkPermissionChange(): void {
    const permission = currentPermission();
    if (permission === this.lastPermission) return;
    this.lastPermission = permission;
    const event: PermissionChangeEvent = { permission: permission === 'granted', state: permission };
    for (const o of this.permissionObservers) {
      try {
        o(event);
      } catch (err) {
        this.logger.warn('izin gözlemcisi hata verdi', err);
      }
    }
  }

  /**
   * İzin değişimini izler: Permissions API `change` olayı (destekleyen tarayıcılarda; kullanıcının site
   * ayarlarından değiştirmesi dahil) ve sayfa yeniden görünür olduğunda kontrol. Ağ çağrısı yapmaz.
   */
  private installPermissionWatch(): void {
    if (this.permissionWatchInstalled || typeof window === 'undefined') return;
    this.permissionWatchInstalled = true;
    this.lastPermission = currentPermission();
    const check = () => this.checkPermissionChange();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    const permissions = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
    if (!permissions?.query) return;
    permissions
      .query({ name: 'notifications' })
      .then((status) => status.addEventListener('change', check))
      .catch((err: unknown) => this.logger.debug('Permissions API kullanılamıyor', err));
  }

  private notifySubscription(): void {
    const state = this.User.pushSubscription.state;
    for (const o of this.subscriptionObservers) o(state);
    this.syncIdentity();
    this.renderCustomLinks();
  }

  private async toggleBell(): Promise<void> {
    if (this.User.pushSubscription.optedIn) await this.User.pushSubscription.optOut();
    else await this.User.pushSubscription.optIn();
  }

  /**
   * İzin istemi: tetikler (sayfa görüntüleme, gecikme, kaydırma) sağlanınca slidedown veya native istem.
   * Reddedilen istem geri çekilme takvimine göre (varsayılan 3/7/30 gün) yeniden gösterilir; `force` takvimi,
   * sayfa görüntüleme ve gecikme koşullarını atlar (yalnızca izin henüz sorulmamışsa gösterilir).
   */
  private async maybeShowSlidedown(
    opts: SlidedownOptions,
    mode: 'slidedown' | 'native' = 'slidedown',
    force = false,
  ): Promise<void> {
    // E-posta/SMS toplama istemi (ADR-0019 §11): izin durumu yerine "yanıtlandı" bayrağı belirleyicidir.
    const contact = collectsContact(opts.collect);
    const alreadyAnswered = () =>
      contact ? this.store!.get().contactPromptAnswered : currentPermission() !== 'default';
    if (alreadyAnswered()) return;
    const state = this.store!.get();
    if (!force) {
      if (state.pageViews < (opts.pageViews ?? 1)) return;
      const schedule =
        opts.retryDays !== undefined
          ? [opts.retryDays]
          : (this.options?.promptOptions?.backoffDays ?? this.config?.web.prompt_backoff_days ?? DEFAULT_PROMPT_BACKOFF_DAYS);
      const dismissedAt = contact ? state.contactPromptDismissedAt : state.slidedownDismissedAt;
      // Eski sürüm kaydı: ret anı var, sayaç yok → bir ret sayılır.
      const count = contact
        ? state.contactPromptDismissCount
        : Math.max(state.promptDismissCount, state.slidedownDismissedAt ? 1 : 0);
      if (!promptBackoffElapsed(count, dismissedAt, Date.now(), schedule)) return;
      await new Promise((r) => setTimeout(r, (opts.delaySeconds ?? 0) * 1000));
      if (opts.scrollPercent !== undefined && opts.scrollPercent > 0)
        await waitForScrollPercent(Math.min(100, opts.scrollPercent));
      if (alreadyAnswered()) return;
    }
    if (mode === 'native' && !contact) {
      // Native istem kapatıldıysa (karar verilmedi) bir ret sayılır.
      if ((await this.Notifications.requestPermission()) === 'default') this.recordPromptDismissed('push');
      return;
    }
    const result = await showSlidedown(opts, this.language, this.store!.get().tags);
    if (!result.accepted) {
      this.recordPromptDismissed(contact ? 'contact' : 'push');
      return;
    }
    if (contact) {
      // Adresler mevcut kayıt akışıyla (çevrimdışı kuyruk) eklenir; slidedown zaten doğruladı.
      if (result.email) this.User.addEmail(result.email);
      if (result.sms) this.User.addSms(result.sms);
      this.store!.update({ contactPromptAnswered: true });
    } else {
      await this.Notifications.requestPermission();
    }
    // Kategori seçimi tag olarak yazılır (kullanıcı oluşunca kuyruk gönderir).
    if (Object.keys(result.tags).length > 0)
      this.enqueue({ type: 'tags', tags: result.tags, at: Date.now() });
  }

  /** Ret kaydı: push istemi ve e-posta/SMS istemi ayrı sayaç/zaman tutar, aynı geri çekilme takvimini kullanır. */
  private recordPromptDismissed(kind: 'push' | 'contact'): void {
    const state = this.store!.get();
    if (kind === 'contact') {
      this.store!.update({
        contactPromptDismissedAt: Date.now(),
        contactPromptDismissCount: state.contactPromptDismissCount + 1,
      });
      return;
    }
    this.store!.update({
      slidedownDismissedAt: Date.now(),
      promptDismissCount: Math.max(state.promptDismissCount, state.slidedownDismissedAt ? 1 : 0) + 1,
    });
  }

  /** `Slidedown.promptEmail/promptSms/promptEmailAndSms`: slidedown seçenekleri + istenen kanal. */
  private async promptContact(collect: SlidedownCollect, force: boolean): Promise<void> {
    this.assertReady();
    await this.maybeShowSlidedown({ ...this.slidedownOptions(), collect }, 'slidedown', force);
  }

  /** Init `slidedown`, yoksa dashboard istemi, o da yoksa varsayılan metinler. */
  private slidedownOptions(): SlidedownOptions {
    const remote = this.config?.web.prompt;
    return (
      this.options?.slidedown ?? (remote ? slidedownFromRemote(remote, this.language) : {})
    );
  }

  // --- Public API ---

  /**
   * Kullanıcıyı kimliklendirir. Kimlik kanıtı app ayarına göre HMAC `identityHash` (eski imza: ikinci argüman dize)
   * ve/veya sunucunuzda imzalanmış ES256 JWT'dir: `login(id, { jwt })`. JWT, SDK isteklerinde `Authorization` başlığıyla
   * gider; süresi dolunca `updateUserJwt` ile yenilenir.
   */
  async login(externalId: string, proof?: string | { identityHash?: string; jwt?: string }): Promise<void> {
    this.assertReady();
    if (!externalId) throw new Error('externalId gerekli');
    const identityHash = typeof proof === 'string' ? proof : proof?.identityHash;
    const jwt = typeof proof === 'object' ? proof.jwt : undefined;
    if (this.config?.identity_verification_required) {
      const mode = this.config.identity_verification_mode ?? 'hmac';
      if (mode === 'jwt' && !jwt) throw new Error('Bu app için kimlik JWT\'si (login(id, { jwt })) zorunlu.');
      if (mode === 'hmac' && !identityHash) throw new Error('Bu app için identityHash zorunlu.');
      if (mode === 'both' && !jwt && !identityHash) throw new Error('Bu app için identityHash veya JWT zorunlu.');
    }
    // JWT bu girişin isteğinde de başlıkta gitmelidir: istekten önce saklanır.
    this.store!.update({ identityJwt: jwt ?? null });
    const state = this.store!.get();
    // Cihaz aboneliğinin login'i anonim kullanıcıyı birleştirir/kimliklendirir; aynı anonim kullanıcıdaki
    // e-posta/SMS abonelikleri de onunla birlikte taşınır (ayrı istek gerekmez).
    let moved: { fromUserId: string; result: UserResult } | null = null;
    if (state.subscriptionId) {
      const result = await this.api!.request<UserResult>(
        'POST',
        `/subscriptions/${state.subscriptionId}/login`,
        // identity_hash hedef kullanıcıya aittir; aboneliğin kanıtı kayıtlı token'ın özetidir (ADR-0016).
        { external_id: externalId, identity_hash: identityHash, ...ownershipProof(state.tokenHash) },
      );
      if (state.userId && !state.externalId) moved = { fromUserId: state.userId, result };
      this.store!.update({
        userId: result.user_id,
        externalId: result.external_id,
        identityHash: identityHash ?? null,
        tags: result.tags,
      });
    } else {
      // Abonelik yok: kimlik saklanır, ilk kayıtta kullanılır.
      this.store!.update({ externalId, identityHash: identityHash ?? null });
      if (currentPermission() === 'granted')
        await this.registerTokenIfPossible({
          external_id: externalId,
          identity_hash: identityHash,
        });
    }
    await this.linkContacts(externalId, identityHash, moved);
    this.syncIdentity();
    await this.queue!.flush();
  }

  private async registerTokenIfPossible(user: {
    external_id: string;
    identity_hash?: string;
  }): Promise<void> {
    if (!this.push || !this.config?.web.vapid_public_key) return;
    const sub = await this.push.subscribe(this.config.web.vapid_public_key);
    await this.registerToken(sub.toJSON(), user);
  }

  async logout(): Promise<void> {
    this.assertReady();
    const state = this.store!.get();
    if (state.subscriptionId) {
      const result = await this.api!.request<UserResult>(
        'POST',
        `/subscriptions/${state.subscriptionId}/logout`,
        ownershipProof(state.tokenHash, state.identityHash),
      );
      this.store!.update({
        userId: result.user_id,
        externalId: null,
        identityHash: null,
        identityJwt: null,
        tags: {},
      });
    } else {
      this.store!.update({ externalId: null, identityHash: null, identityJwt: null, userId: null, tags: {} });
    }
    // E-posta/SMS abonelikleri kimlikli kullanıcıda kalır; bu cihazın yeni anonim kullanıcısıyla ilişkisi kesilir.
    if (state.externalId) this.store!.update({ contactSubscriptions: [] });
    this.syncIdentity();
  }

  /**
   * Süresi dolan veya yenilenen kimlik JWT'sini günceller (giriş yapmış kullanıcı için). Sonraki SDK istekleri yeni
   * belirteci taşır; kuyrukta bekleyen işlemler yeniden denenir.
   */
  async updateUserJwt(jwt: string): Promise<void> {
    this.assertReady();
    if (!jwt) throw new Error('jwt gerekli');
    if (!this.store!.get().externalId) throw new Error('Önce login ile kullanıcı kimliklendirilmeli.');
    this.store!.update({ identityJwt: jwt });
    await this.queue!.flush();
  }

  readonly User = {
    addTag: (key: string, value: string): void =>
      this.enqueue({ type: 'tags', tags: { [key]: String(value) }, at: Date.now() }),
    addTags: (tags: Record<string, string>): void =>
      this.enqueue({
        type: 'tags',
        tags: Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, String(v)])),
        at: Date.now(),
      }),
    removeTag: (key: string): void =>
      this.enqueue({ type: 'tags', tags: { [key]: null }, at: Date.now() }),
    removeTags: (keys: string[]): void =>
      this.enqueue({
        type: 'tags',
        tags: Object.fromEntries(keys.map((k) => [k, null])),
        at: Date.now(),
      }),
    getTags: (): Record<string, string> => ({ ...(this.store?.get().tags ?? {}) }),
    setLanguage: (code: string): void => {
      this.language = code;
      this.enqueue({ type: 'properties', properties: { language: code }, at: Date.now() });
    },
    setProperty: (key: string, value: unknown): void =>
      this.enqueue({ type: 'properties', properties: { [key]: value }, at: Date.now() }),
    /** Kullanıcıya alias ekler (ör. `addAlias('crm_id', '42')`); çevrimdışıyken kuyrukta bekler. */
    addAlias: (label: string, id: string): void =>
      this.enqueue({
        type: 'alias_add',
        aliases: normalizeAliases({ [label]: id }),
        at: Date.now(),
      }),
    /** Birden çok alias'ı tek istekte ekler (en fazla 20). */
    addAliases: (aliases: Record<string, string>): void =>
      this.enqueue({ type: 'alias_add', aliases: normalizeAliases(aliases), at: Date.now() }),
    removeAlias: (label: string): void => {
      assertAliasLabel(label);
      this.enqueue({ type: 'alias_remove', label, at: Date.now() });
    },
    /**
     * E-posta aboneliği ekler (küçük harfe çevrilir; geçersizse `ContactValidationError`).
     * Login olunmuşsa abonelik external_id ile kullanıcıya bağlanır; çevrimdışıyken kuyrukta bekler.
     */
    addEmail: (email: string): void => this.enqueueContact('contact_add', 'email', email),
    /** Bu cihazda eklenen e-posta aboneliğini siler. */
    removeEmail: (email: string): void => this.enqueueContact('contact_remove', 'email', email),
    /** SMS aboneliği ekler (E.164'e normalize edilir: boşluk/tire/parantez atılır, `00` → `+`). */
    addSms: (phone: string): void => this.enqueueContact('contact_add', 'sms', phone),
    /** Bu cihazda eklenen SMS aboneliğini siler. */
    removeSms: (phone: string): void => this.enqueueContact('contact_remove', 'sms', phone),
    /**
     * Kullanıcı tercihleri (ADR-0019 §4): kategori × kanal opt-in durumu ve app kategorileri.
     * Abonelik (push ya da e-posta/SMS) ve sahiplik kanıtı gerekir; yoksa açıklayıcı hata fırlatılır.
     */
    getPreferences: async (): Promise<UserPreferences> => {
      this.assertReady();
      const auth = this.preferencesAuth();
      if (!auth) throw new Error('Tercihler için abonelik gerekli (push, e-posta veya SMS).');
      return preferencesFromApi(await fetchPreferences(this.api!, auth));
    },
    /**
     * Tercihleri yazar (`channel` yoksa tüm kanallar). Diğer kullanıcı işlemleri gibi çevrimdışı kuyruğa
     * alınır; abonelik oluşunca gönderilir.
     */
    setPreferences: (preferences: PreferenceInput[]): void => {
      this.assertReady();
      const list = Array.isArray(preferences) ? preferences : [];
      if (list.length === 0 || list.length > 100)
        throw new Error('setPreferences: 1-100 tercih gerekli.');
      const normalized: PreferenceInput[] = list.map((p) => {
        const category = String(p?.category ?? '').trim();
        if (!category || category.length > 64)
          throw new Error('setPreferences: geçersiz kategori anahtarı.');
        return {
          category,
          optedIn: p.optedIn === true,
          ...(p.channel !== undefined ? { channel: p.channel ?? null } : {}),
        };
      });
      this.enqueue({ type: 'preferences', preferences: normalized, at: Date.now() });
    },
    /** `GET /config` ile gelen mesaj kategorileri (tercih merkezi arayüzü için; ağ çağrısı yapmaz). */
    getCategories: (): PreferenceCategory[] =>
      (this.config?.categories ?? []).map(categoryFromApi),
    get externalId(): string | null {
      return sdkRef.store?.get().externalId ?? null;
    },
    get id(): string | null {
      return sdkRef.store?.get().userId ?? null;
    },
    pushSubscription: {
      get id(): string | null {
        return sdkRef.store?.get().subscriptionId ?? null;
      },
      /** Tarayıcı PushSubscription endpoint'i (abonelik yoksa null). */
      get token(): string | null {
        const s = sdkRef.store?.get();
        return s?.subscriptionId ? (s.pushEndpoint ?? null) : null;
      },
      get optedIn(): boolean {
        return (sdkRef.store?.get().optedIn ?? false) && currentPermission() === 'granted';
      },
      get state(): PushSubscriptionState {
        const s = sdkRef.store?.get();
        return {
          id: s?.subscriptionId ?? null,
          token: s?.subscriptionId ? (s.pushEndpoint ?? null) : null,
          optedIn: (s?.optedIn ?? false) && currentPermission() === 'granted',
          permission: currentPermission(),
        };
      },
      optIn: async (): Promise<void> => {
        sdkRef.assertReady();
        if (currentPermission() !== 'granted') {
          const p = await sdkRef.Notifications.requestPermission();
          if (p !== 'granted') return;
        }
        await sdkRef.subscribeNow();
      },
      optOut: async (): Promise<void> => {
        sdkRef.assertReady();
        const state = sdkRef.store!.get();
        if (state.subscriptionId)
          await sdkRef.api!.request('PATCH', `/subscriptions/${state.subscriptionId}`, {
            opted_in: false,
            ...ownershipProof(state.tokenHash),
          });
        sdkRef.store!.update({ optedIn: false });
        sdkRef.notifySubscription();
      },
      addObserver: (cb: Listener<PushSubscriptionState>): (() => void) => {
        sdkRef.subscriptionObservers.add(cb);
        return () => sdkRef.subscriptionObservers.delete(cb);
      },
      /** `addObserver` ile eklenen gözlemciyi kaldırır (dönen fonksiyonla eşdeğer). */
      removeObserver: (cb: Listener<PushSubscriptionState>): void => {
        sdkRef.subscriptionObservers.delete(cb);
      },
    },
  };

  readonly Notifications = {
    get permission(): PermissionState {
      return currentPermission();
    },
    requestPermission: async (): Promise<PermissionState> => {
      this.assertReady();
      if (!isPushSupported()) return 'unsupported';
      const result = await Notification.requestPermission();
      this.checkPermissionChange();
      if (result === 'granted') {
        try {
          await this.subscribeNow();
        } catch (err) {
          this.logger.error('abonelik oluşturulamadı', err);
          this.reportError('registration_failed', 'push aboneliği oluşturulamadı', err);
        }
      }
      this.notifySubscription();
      return result;
    },
    addClickListener: (cb: Listener<NotificationClickEvent>): (() => void) => {
      this.clickListeners.add(cb);
      return () => this.clickListeners.delete(cb);
    },
    addForegroundLifecycleListener: (cb: Listener<ForegroundLifecycleEvent>): (() => void) => {
      this.foregroundListeners.add(cb);
      return () => this.foregroundListeners.delete(cb);
    },
    /**
     * İzin değişimi gözlemcisi: istem sonucu ve (Permissions API destekleniyorsa) kullanıcının site
     * ayarlarından yaptığı değişiklikler bildirilir. Dönen fonksiyon gözlemciyi kaldırır.
     */
    addPermissionObserver: (cb: Listener<PermissionChangeEvent>): (() => void) => {
      this.permissionObservers.add(cb);
      this.installPermissionWatch();
      return () => this.permissionObservers.delete(cb);
    },
    removePermissionObserver: (cb: Listener<PermissionChangeEvent>): void => {
      this.permissionObservers.delete(cb);
    },
    /** Bu sitenin service worker'ının gösterdiği tüm bildirimleri kapatır (ağ çağrısı yapmaz). */
    clearAll: async (): Promise<void> => {
      if (!this.push) return;
      await this.push.clearNotifications();
    },
  };

  /** İzin istemleri (eski sağlayıcı `Slidedown`). */
  readonly Slidedown = {
    /**
     * Slidedown istemini gösterir. Varsayılan olarak geri çekilme takvimine ve tetiklere uyar;
     * `{ force: true }` bunları atlar (izin zaten verildi/reddedildiyse yine gösterilmez).
     */
    promptPush: async (options?: { force?: boolean }): Promise<void> => {
      this.assertReady();
      await this.maybeShowSlidedown(
        { ...this.slidedownOptions(), collect: 'push' },
        'slidedown',
        options?.force === true,
      );
    },
    /** E-posta toplama istemi (ADR-0019 §11); kabulde `User.addEmail`. Yanıtlandıysa gösterilmez. */
    promptEmail: (options?: { force?: boolean }): Promise<void> =>
      this.promptContact('email', options?.force === true),
    /** SMS toplama istemi; kabulde `User.addSms`. */
    promptSms: (options?: { force?: boolean }): Promise<void> =>
      this.promptContact('sms', options?.force === true),
    /** E-posta + SMS toplama istemi (tek kutu, iki alan). */
    promptEmailAndSms: (options?: { force?: boolean }): Promise<void> =>
      this.promptContact('email_sms', options?.force === true),
  };

  /**
   * Konum paylaşımı (v2 Faz 17b; yalnızca ön plan). Paylaşım açıkken konum oturum başında ve sayfa ön plana döndüğünde
   * en sık 5 dakikada bir push aboneliğine yazılır; izin yoksa veya gizlilik onayı verilmemişse gönderilmez. İlk konum
   * sunucuda KVKK açık rıza kaydı sayılır; `setShared(false)` konumu ve rıza kaydını hemen sildirir.
   */
  readonly Location = {
    /** Paylaşımı açar/kapatır (kalıcı). Açılırken izin varsa konum hemen gönderilir; izin için `requestPermission`. */
    setShared: (shared: boolean): void => {
      if (!this.store) throw new Error('Pushizo.init önce çağrılmalı.');
      const wasShared = this.store.get().locationShared;
      const enabled = shared === true;
      this.store.update({ locationShared: enabled, ...(enabled ? {} : { locationSentAt: null }) });
      if (enabled) {
        void this.refreshLocation(!wasShared);
        return;
      }
      // Kapatma: sunucudaki konum ve rıza kaydı silinir (onay bekleniyorsa onay verilince gönderilir).
      if (wasShared) this.enqueue({ type: 'location', location: null, at: Date.now() });
    },
    /** Paylaşım açık mı (kalıcı tercih; izin durumundan bağımsız). */
    get isShared(): boolean {
      return sdkRef.store?.get().locationShared ?? false;
    },
    /**
     * Konum iznini ister. İzin henüz verilmediyse önce açıklama kutusu gösterilir (`rationale`, yoksa varsayılan metin);
     * kullanıcı vazgeçerse tarayıcı istemi açılmaz. İzin verildiyse (veya zaten varsa) true; reddedildiyse/desteklenmiyorsa false.
     * Paylaşım açıksa alınan konum hemen gönderilir.
     */
    requestPermission: async (rationale?: string): Promise<boolean> => {
      if (!this.store) throw new Error('Pushizo.init önce çağrılmalı.');
      if (!isGeolocationSupported()) return false;
      const permission = await geolocationPermission();
      if (permission === 'denied') {
        this.store.update({ locationPermissionGranted: false });
        return false;
      }
      // Önce açıklama (verilmezse varsayılan metin); vazgeçilirse tarayıcı istemi hiç açılmaz.
      if (permission !== 'granted' && typeof document !== 'undefined') {
        if (!(await showLocationRationale(rationale, this.language))) return false;
      }
      // İzin sorulmadıysa tarayıcı istemi burada açılır.
      const result = await currentPosition();
      if (result.kind === 'denied') {
        this.store.update({ locationPermissionGranted: false });
        return false;
      }
      this.store.update({ locationPermissionGranted: true });
      const state = this.store.get();
      if (result.kind === 'fix' && this.started && locationRefreshDue(state.locationShared, state.locationSentAt, Date.now()))
        this.sendLocation(result.fix);
      return true;
    },
  };

  /** Özel bağlantı istemi: sonradan eklenen `.pushizo-customlink-container` öğeleri için yeniden çizer. */
  readonly CustomLink = {
    render: (): void => this.renderCustomLinks(),
  };

  readonly Session = {
    sendEvent: (name: string, properties?: Record<string, unknown>, value?: number): void => {
      this.enqueue({
        type: 'event',
        name,
        properties,
        value,
        occurredAt: new Date().toISOString(),
        eventId: newEventId(),
        at: Date.now(),
      });
      // Olay adı in-app `event` tetiklerini değerlendirir.
      this.inApp.onEvent(name);
    },
  };

  /** Uygulama içi mesajlar (docs/messaging.md §7). Tetik değerleri yalnızca sayfa ömrü boyunca tutulur. */
  readonly InAppMessages = {
    addTrigger: (key: string, value: InAppTriggerValue): void =>
      this.inApp.setTriggers({ [key]: value }),
    addTriggers: (triggers: Record<string, InAppTriggerValue>): void =>
      this.inApp.setTriggers(triggers),
    removeTrigger: (key: string): void => this.inApp.removeTriggers([key]),
    removeTriggers: (keys: string[]): void => this.inApp.removeTriggers(keys),
    clearTriggers: (): void => this.inApp.clearTriggers(),
    getTriggers: (): Record<string, InAppTriggerValue> => this.inApp.triggers,
    /** Geçerli ekran/sayfa adı; `screen` tetikli mesajları değerlendirir. */
    setScreen: (name: string): void => this.inApp.setScreen(name),
    addClickListener: (cb: Listener<InAppClickEvent>): (() => void) => {
      this.inApp.clickListeners.add(cb);
      return () => this.inApp.clickListeners.delete(cb);
    },
    removeClickListener: (cb: Listener<InAppClickEvent>): void => {
      this.inApp.clickListeners.delete(cb);
    },
    /** `willDisplay`, `didDisplay`, `willDismiss`, `didDismiss` geri çağrıları. */
    addLifecycleListener: (listener: InAppLifecycleListener): (() => void) => {
      this.inApp.lifecycleListeners.add(listener);
      return () => this.inApp.lifecycleListeners.delete(listener);
    },
    removeLifecycleListener: (listener: InAppLifecycleListener): void => {
      this.inApp.lifecycleListeners.delete(listener);
    },
    /** `true` iken yeni mesaj gösterilmez. */
    get paused(): boolean {
      return sdkRef.inApp.paused;
    },
    set paused(value: boolean) {
      sdkRef.inApp.paused = value;
    },
  };

  /** Bildirim kutusu (docs/messaging.md §8); kullanıcı ve ona ait bir abonelik gerekir. */
  readonly Inbox = {
    list: async (options?: InboxListOptions) => {
      this.assertReady();
      return this.inbox.list(options);
    },
    markRead: async (itemId: string) => {
      this.assertReady();
      return this.inbox.markRead(itemId);
    },
    markAllRead: async () => {
      this.assertReady();
      return this.inbox.markAllRead();
    },
    /** Öğeyi kutudan kaldırır (sunucuda arşivlenir). */
    archive: async (itemId: string): Promise<void> => {
      this.assertReady();
      return this.inbox.archive(itemId);
    },
    unreadCount: async (): Promise<number> => {
      this.assertReady();
      return this.inbox.unreadCount();
    },
    addObserver: (cb: Listener<InboxChangeEvent>): (() => void) => this.inbox.addObserver(cb),
    removeObserver: (cb: Listener<InboxChangeEvent>): void => this.inbox.removeObserver(cb),
  };

  private enqueueContact(
    type: 'contact_add' | 'contact_remove',
    channel: ContactChannel,
    value: string,
  ): void {
    this.assertReady();
    const token = normalizeContact(channel, value);
    this.enqueue({ type, channel, token, at: Date.now() });
  }

  readonly Debug = {
    setLogLevel: (level: LogLevel): void => this.logger.setLevel(level),
  };

  /** Test/araç amaçlı: bekleyen kuyruk boyutu. */
  get pendingOperations(): number {
    return this.queue?.size ?? 0;
  }

  private assertReady(): void {
    if (!this.api || !this.store || !this.queue)
      throw new Error('Pushizo.init önce çağrılmalı.');
    if (this.options?.requiresPrivacyConsent && !this.store.get().consentGiven)
      throw new Error('Gizlilik onayı verilmedi (setConsentGiven).');
  }

  destroy(): void {
    // Bekleyen toplu olay gönderimi iptal edilir; olaylar kalıcı kuyrukta kalır, sonraki init'te gönderilir.
    if (this.eventFlushTimer) clearTimeout(this.eventFlushTimer);
    this.eventFlushTimer = null;
    this.unmountBell?.();
    this.session?.end();
    this.inApp.destroy();
  }
}

// `User`/`Notifications` nesnelerindeki getter'lar sınıf örneğine erişebilsin diye tek örnek referansı.
let sdkRef: PushizoSdk;
export function createSdk(): PushizoSdk {
  sdkRef = new PushizoSdk();
  return sdkRef;
}

function inferApiUrl(): string {
  if (typeof document !== 'undefined') {
    const script = document.currentScript as HTMLScriptElement | null;
    const src =
      script?.src ?? Array.from(document.scripts).find((s) => s.src.includes('PushizoSDK'))?.src;
    if (src) {
      const u = new URL(src);
      return u.origin;
    }
  }
  return typeof window !== 'undefined' ? window.location.origin : '';
}

function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

function osName(ua: string): string {
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Mac OS/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}
