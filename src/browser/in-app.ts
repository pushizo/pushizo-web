import { fetchInAppMessages, type SdkApi } from '../core/api.js';
import { isNetworkError } from '../core/errors.js';
import {
  frequencyAllows,
  globalIntervalAllows,
  nextSessionDurationDelay,
  pickMessage,
  safeDeeplink,
  safeHttpUrl,
  type GlobalInterval,
  type TriggerContext,
} from '../core/in-app-logic.js';
import type { Logger } from '../core/logger.js';
import type { StateStore } from '../core/storage.js';
import type {
  InAppClickEvent,
  InAppLifecycleEvent,
  InAppLifecycleListener,
  InAppMessage,
  InAppTriggerValue,
  QueuedOperation,
} from '../core/types.js';
import { renderInAppMessage, type InAppButtonBlock, type RenderedInApp } from './in-app-render.js';

/** Liste en fazla bu sıklıkla yenilenir (docs/messaging.md §7). */
export const IN_APP_REFRESH_MS = 5 * 60_000;
/** Başarısız yenilemeden sonra yeniden deneme aralığı. */
const IN_APP_RETRY_MS = 60_000;
const MAX_TRIGGER_KEY = 64;

type InAppEventOp = Extract<QueuedOperation, { type: 'in_app_event' }>;

/** SDK'nın in-app yöneticisine sağladığı bağımlılıklar (init'ten sonra çözülür). */
export interface InAppHost {
  api: () => SdkApi | null;
  store: () => StateStore | null;
  logger: Logger;
  language: () => string;
  /** In-app için kullanılacak abonelik (push, yoksa e-posta/SMS); yoksa null. */
  subscriptionId: () => string | null;
  /** Aboneliğin sahiplik kanıtı özeti (ADR-0016; push: kayıtlı token, e-posta/SMS: kanonik adres); yoksa null. */
  ownershipHash: (subscriptionId: string) => string | null;
  enqueue: (op: InAppEventOp) => void;
  addTags: (tags: Record<string, string>) => void;
  /** `push_prompt` aksiyonu: yerel push izin istemi (mevcut `Notifications.requestPermission` akışı). */
  requestPushPermission: () => Promise<unknown>;
  /** `outcome` aksiyonu: olay gönderimi (mevcut `Session.sendEvent`). */
  sendOutcome: (name: string, value?: number) => void;
  /** App geneli gösterim aralığı (`config.in_app.min_interval_seconds`); yoksa 0. */
  globalMinIntervalSeconds: () => number;
  reportError: (code: string, message: string, err?: unknown) => void;
  /** Testler için değiştirilebilir. */
  now?: () => number;
  render?: typeof renderInAppMessage;
  openUrl?: (url: string) => void;
  navigate?: (url: string) => void;
}

interface Showing {
  message: InAppMessage;
  handle: RenderedInApp;
}

/**
 * In-app mesaj yöneticisi: listeyi oturum başında ve en fazla 5 dakikada bir yeniler, tetikleri
 * değerlendirir, aynı anda tek mesaj gösterir (öncelik yüksek olan), sıklığı yerelde de uygular ve
 * gösterim/tıklama/kapatma olaylarını çevrimdışı kuyruğa yazar.
 */
export class InAppManager {
  private messages: InAppMessage[] = [];
  private loaded = false;
  private nextFetchAt = 0;
  private fetching: Promise<void> | null = null;
  private readonly triggerValues: Record<string, InAppTriggerValue> = {};
  private screen: string | null = null;
  private sessionStartPending = false;
  private showing: Showing | null = null;
  /** Bir mesaj açıkken uygun hale gelenler (kapanınca öncelik sırasıyla denenir). */
  private waiting: InAppMessage[] = [];
  private pausedFlag = false;
  private started = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  /** Geçerli oturumun başlangıcı (epoch ms); `session_duration` koşulları buna göre ölçülür. */
  private sessionStartedAt: number | null = null;
  /** Bir sonraki `session_duration` eşiği için zamanlayıcı. */
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  readonly clickListeners = new Set<(event: InAppClickEvent) => void>();
  readonly lifecycleListeners = new Set<InAppLifecycleListener>();

  constructor(private readonly host: InAppHost) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  /** SDK başlatıldı: periyodik yenileme kurulur. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof setInterval === 'function')
      this.interval = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible')
          void this.refresh(false);
      }, IN_APP_REFRESH_MS);
  }

  destroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.clearDurationTimer();
    this.started = false;
    this.closeCurrent();
  }

  /** Geçerli oturumun süresi (saniye); oturum başlamadıysa 0. */
  private sessionElapsedSeconds(): number {
    if (this.sessionStartedAt === null) return 0;
    return Math.max(0, Math.floor((this.now() - this.sessionStartedAt) / 1000));
  }

  private clearDurationTimer(): void {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
  }

  /** En yakın dolmamış `session_duration` eşiğinde yeniden değerlendirme planlar. */
  private scheduleDurationTimer(): void {
    this.clearDurationTimer();
    if (!this.started || this.sessionStartedAt === null || typeof setTimeout !== 'function') return;
    const delay = nextSessionDurationDelay(this.messages, this.sessionElapsedSeconds());
    if (delay === null) return;
    this.durationTimer = setTimeout(() => {
      this.durationTimer = null;
      void this.evaluate({});
    }, delay * 1000);
  }

  private globalInterval(): GlobalInterval {
    return {
      minIntervalSeconds: this.host.globalMinIntervalSeconds(),
      lastImpressionAt: this.host.store()?.get().inAppLastImpressionAt ?? null,
    };
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /** Duraklatılınca yeni mesaj gösterilmez (açık mesaj kapanmaz); devam edince durum yeniden değerlendirilir. */
  set paused(value: boolean) {
    const resumed = this.pausedFlag && !value;
    this.pausedFlag = value;
    if (resumed) void this.evaluate({});
  }

  get triggers(): Record<string, InAppTriggerValue> {
    return { ...this.triggerValues };
  }

  // --- Tetikler ---

  setTriggers(values: Record<string, InAppTriggerValue>): void {
    for (const [key, value] of Object.entries(values)) {
      if (!key || key.length > MAX_TRIGGER_KEY)
        throw new Error(`Geçersiz tetik anahtarı "${key}" (1-${MAX_TRIGGER_KEY} karakter).`);
      if (!['string', 'number', 'boolean'].includes(typeof value))
        throw new Error(`"${key}" tetik değeri metin, sayı veya mantıksal değer olmalı.`);
    }
    let changed = false;
    for (const [key, value] of Object.entries(values)) {
      if (this.triggerValues[key] === value) continue;
      this.triggerValues[key] = value;
      changed = true;
    }
    if (changed) void this.evaluate({});
  }

  removeTriggers(keys: string[]): void {
    let changed = false;
    for (const key of keys) {
      if (!(key in this.triggerValues)) continue;
      delete this.triggerValues[key];
      changed = true;
    }
    if (changed) void this.evaluate({});
  }

  clearTriggers(): void {
    this.removeTriggers(Object.keys(this.triggerValues));
  }

  setScreen(name: string | null): void {
    const next = name ? String(name).slice(0, 100) : null;
    if (next === this.screen) return;
    this.screen = next;
    if (next) void this.evaluate({});
  }

  // --- SDK olayları ---

  /** Yeni oturum: liste yenilenir ve `session_start` koşulları değerlendirilir. */
  onSessionStart(): void {
    this.sessionStartPending = true;
    this.sessionStartedAt = this.now();
    void this.refresh(true).then(() => this.evaluate({}));
  }

  /** Oturum bitti: süre koşulları sıfırlanır (yeni oturumda yeniden sayılır). */
  onSessionEnd(): void {
    this.sessionStartedAt = null;
    this.clearDurationTimer();
  }

  /** `Session.sendEvent` adı. */
  onEvent(name: string): void {
    void this.evaluate({ eventName: name });
  }

  /** Abonelik veya kullanıcı değişti: liste yeniden alınır (kitle/sıklık kullanıcıya göredir). */
  onIdentityChanged(): void {
    this.loaded = false;
    this.nextFetchAt = 0;
    void this.refresh(true).then(() => this.evaluate({}));
  }

  /** Sunucuya ulaşan gösterim: yerel bekleyen sayısı düşülür, bellekteki liste güncellenir. */
  acknowledgeImpression(messageId: string): void {
    const store = this.host.store();
    if (!store) return;
    const local = store.get().inAppLocal;
    const record = local[messageId];
    if (!record || record.pending <= 0) return;
    store.update({
      inAppLocal: { ...local, [messageId]: { ...record, pending: record.pending - 1 } },
    });
    const message = this.messages.find((m) => m.id === messageId);
    if (message) {
      message.remaining_impressions = Math.max(0, message.remaining_impressions - 1);
      message.last_impression_at = new Date(record.lastAt).toISOString();
    }
  }

  // --- Liste ---

  /** Listeyi yeniler; `force` değilse yalnızca süresi dolmuşsa. Eşzamanlı çağrılar aynı isteği bekler. */
  refresh(force: boolean): Promise<void> {
    if (this.fetching) return this.fetching;
    const api = this.host.api();
    const subscriptionId = this.host.subscriptionId();
    if (!this.started || !api || !subscriptionId) return Promise.resolve();
    if (!force && this.loaded && this.now() < this.nextFetchAt) return Promise.resolve();
    this.fetching = fetchInAppMessages(api, subscriptionId, this.host.ownershipHash(subscriptionId))
      .then((result) => {
        this.messages = (result.data ?? []).filter(isRenderable);
        this.loaded = true;
        this.nextFetchAt = this.now() + IN_APP_REFRESH_MS;
        this.pruneLocal();
        this.scheduleDurationTimer();
        this.host.logger.debug(`in-app listesi yenilendi (${this.messages.length} mesaj)`);
      })
      .catch((err: unknown) => {
        this.nextFetchAt = this.now() + IN_APP_RETRY_MS;
        this.host.logger.warn('in-app mesajları alınamadı', err);
        if (!isNetworkError(err))
          this.host.reportError('in_app_fetch_failed', 'in-app mesajları alınamadı', err);
      })
      .finally(() => {
        this.fetching = null;
      });
    return this.fetching;
  }

  /** Listede artık olmayan ve bekleyen gösterimi kalmayan yerel kayıtlar silinir. */
  private pruneLocal(): void {
    const store = this.host.store();
    if (!store) return;
    const ids = new Set(this.messages.map((m) => m.id));
    const local = store.get().inAppLocal;
    const kept = Object.fromEntries(
      Object.entries(local).filter(([id, r]) => ids.has(id) || r.pending > 0),
    );
    if (Object.keys(kept).length !== Object.keys(local).length) store.update({ inAppLocal: kept });
  }

  // --- Değerlendirme ve gösterim ---

  /** Tetikleri değerlendirir ve uygun en yüksek öncelikli mesajı gösterir. */
  async evaluate(reason: { eventName?: string }): Promise<void> {
    if (!this.started || !this.host.subscriptionId()) return;
    if (!this.loaded || this.now() >= this.nextFetchAt) await this.refresh(false);
    if (!this.loaded) return;
    const sessionStart = this.sessionStartPending;
    // Oturum başlangıcı tek değerlendirmede tüketilir (liste yüklendikten sonra).
    this.sessionStartPending = false;
    if (this.pausedFlag) return;
    const store = this.host.store();
    const ctx: TriggerContext = {
      sessionStart,
      eventName: reason.eventName,
      screen: this.screen,
      triggers: this.triggerValues,
      sessionElapsedSeconds: this.sessionElapsedSeconds(),
    };
    // Henüz dolmamış süre eşikleri için zamanlayıcı (liste veya oturum değişince yeniden kurulur).
    this.scheduleDurationTimer();
    const message = pickMessage(
      this.messages,
      ctx,
      store?.get().inAppLocal ?? {},
      this.now(),
      this.globalInterval(),
    );
    if (!message) return;
    if (this.showing) {
      if (this.showing.message.id !== message.id && !this.waiting.some((m) => m.id === message.id))
        this.waiting.push(message);
      return;
    }
    this.show(message);
  }

  private show(message: InAppMessage): void {
    const store = this.host.store();
    const subscriptionId = this.host.subscriptionId();
    if (!store || !subscriptionId) return;
    const event: InAppLifecycleEvent = { message: { id: message.id } };
    this.emitLifecycle('willDisplay', event);
    let handle: RenderedInApp;
    try {
      handle = (this.host.render ?? renderInAppMessage)(message, {
        language: this.host.language(),
        onButton: (button) => this.handleButton(message, button),
        onDismiss: () => this.dismiss(message, true),
        onAutoDismiss: () => this.dismiss(message, false),
      });
    } catch (err) {
      this.host.logger.error('in-app mesajı çizilemedi', err);
      this.host.reportError('in_app_render_failed', 'in-app mesajı çizilemedi', err);
      return;
    }
    this.showing = { message, handle };
    const local = store.get().inAppLocal;
    const now = this.now();
    store.update({
      inAppLocal: {
        ...local,
        [message.id]: { lastAt: now, pending: (local[message.id]?.pending ?? 0) + 1 },
      },
      // App geneli aralık: herhangi bir mesajın son gösterimi.
      inAppLastImpressionAt: now,
    });
    this.track(message, 'impression');
    this.emitLifecycle('didDisplay', event);
  }

  private handleButton(message: InAppMessage, button: InAppButtonBlock): void {
    if (this.showing?.message.id !== message.id) return;
    this.track(message, 'click', button.id);
    this.markInteracted(message);
    const action = button.action;
    const url = action.type === 'url' || action.type === 'deeplink' ? action.url : undefined;
    const click: InAppClickEvent = {
      message: { id: message.id },
      result: { actionId: button.id, ...(url ? { url } : {}) },
    };
    for (const listener of this.clickListeners) {
      try {
        listener(click);
      } catch (err) {
        this.host.logger.error('in-app tıklama dinleyicisi hata verdi', err);
      }
    }
    this.closeCurrent();
    switch (action.type) {
      case 'url': {
        const safe = safeHttpUrl(action.url);
        if (safe) (this.host.openUrl ?? openInNewTab)(safe);
        else this.host.logger.warn('in-app: geçersiz URL aksiyonu yok sayıldı');
        break;
      }
      case 'deeplink': {
        const safe = safeDeeplink(action.url);
        if (safe) (this.host.navigate ?? navigateTo)(safe);
        else this.host.logger.warn('in-app: güvensiz deeplink yok sayıldı');
        break;
      }
      case 'tags':
        if (action.tags && Object.keys(action.tags).length > 0) this.host.addTags(action.tags);
        break;
      case 'push_prompt':
        // Yerel izin istemi; sonucu abonelik akışı yönetir, hata burada yalnızca loglanır.
        this.host.requestPushPermission().catch((err: unknown) => {
          this.host.logger.warn('in-app push_prompt: izin istemi başarısız', err);
          this.host.reportError('in_app_push_prompt_failed', 'in-app push izin istemi başarısız', err);
        });
        break;
      case 'outcome':
        if (typeof action.name === 'string' && action.name.trim())
          this.host.sendOutcome(
            action.name.trim(),
            typeof action.value === 'number' && Number.isFinite(action.value) ? action.value : undefined,
          );
        else this.host.logger.warn('in-app: adı olmayan outcome aksiyonu yok sayıldı');
        break;
      case 'dismiss':
        break;
    }
  }

  private dismiss(message: InAppMessage, byUser: boolean): void {
    if (this.showing?.message.id !== message.id) return;
    // Otomatik kapanma kullanıcı etkileşimi değildir; `dismiss` olayı yalnızca kullanıcı kapatınca gider.
    if (byUser) {
      this.track(message, 'dismiss');
      this.markInteracted(message);
    }
    this.closeCurrent();
  }

  /** `stop_after_interaction` mesajında etkileşim yerelde işaretlenir (liste yenilenmeden tekrar gösterilmez). */
  private markInteracted(message: InAppMessage): void {
    if (!message.stop_after_interaction) return;
    const store = this.host.store();
    if (!store) return;
    const local = store.get().inAppLocal;
    const record = local[message.id] ?? { lastAt: this.now(), pending: 0 };
    store.update({ inAppLocal: { ...local, [message.id]: { ...record, interacted: true } } });
  }

  private closeCurrent(): void {
    const current = this.showing;
    if (!current) return;
    const event: InAppLifecycleEvent = { message: { id: current.message.id } };
    this.emitLifecycle('willDismiss', event);
    current.handle.close();
    this.showing = null;
    this.emitLifecycle('didDismiss', event);
    this.showNext();
  }

  /** Bekleyenlerden sıklık hakkı süren en yüksek öncelikli mesaj gösterilir. */
  private showNext(): void {
    if (this.pausedFlag || !this.started || this.waiting.length === 0) return;
    const local = this.host.store()?.get().inAppLocal ?? {};
    const now = this.now();
    const candidates = this.waiting
      .filter((m) => this.messages.some((x) => x.id === m.id))
      .sort((a, b) => b.priority - a.priority);
    this.waiting = [];
    // App geneli aralık az önce kapanan mesajın gösterimiyle başlar; dolmadıysa bekleyenler atlanır.
    if (!globalIntervalAllows(this.globalInterval(), now)) return;
    const next = candidates.find((m) => frequencyAllows(m, local[m.id], now));
    if (next) this.show(next);
  }

  private track(message: InAppMessage, eventType: InAppEventOp['eventType'], buttonId?: string): void {
    const subscriptionId = this.host.subscriptionId();
    if (!subscriptionId) return;
    this.host.enqueue({
      type: 'in_app_event',
      messageId: message.id,
      subscriptionId,
      eventType,
      ...(buttonId ? { buttonId } : {}),
      ...(typeof message.variant_id === 'string' && message.variant_id
        ? { variantId: message.variant_id }
        : {}),
      at: this.now(),
    });
  }

  private emitLifecycle(kind: keyof InAppLifecycleListener, event: InAppLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener[kind]?.(event);
      } catch (err) {
        this.host.logger.error(`in-app ${kind} dinleyicisi hata verdi`, err);
      }
    }
  }
}

/** Sunucu yanıtında çizilebilir yapı (ileriye dönük uyumluluk: bilinmeyen düzen atlanır). */
function isRenderable(message: InAppMessage): boolean {
  return (
    !!message &&
    typeof message.id === 'string' &&
    (Array.isArray(message.triggers) || Array.isArray(message.trigger_groups)) &&
    !!message.display &&
    Array.isArray(message.display.blocks) &&
    ['modal', 'banner_top', 'banner_bottom', 'fullscreen'].includes(message.display.layout)
  );
}

function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function navigateTo(url: string): void {
  window.location.assign(url);
}
