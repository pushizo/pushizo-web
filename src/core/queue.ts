import type { Logger } from './logger.js';
import { ApiError } from './api.js';
import type { StateStore } from './storage.js';
import type { QueuedOperation } from './types.js';

const MAX_QUEUE = 500;
/** Tek istekte gönderilen en fazla olay (SDK API sınırı: 100). */
export const EVENT_BATCH_MAX = 100;

/**
 * Kimlik (kullanıcı/abonelik) henüz yokken işlemlerin fırlattığı yeniden denenebilir hata kodları.
 * Bu hatayla karşılaşan işlem kuyrukta bekler; kimlik oluşturan işlemler (ör. `contact_add`) yine işlenir.
 */
export const AWAITING_IDENTITY_CODES: ReadonlySet<string> = new Set([
  'NO_USER',
  'NO_SUBSCRIPTION',
  'NO_IDENTITY',
]);

type EventOp = Extract<QueuedOperation, { type: 'event' }>;

/** Kuyruğun başındaki ardışık olay işlemleri (en fazla `EVENT_BATCH_MAX`). */
export function leadingEvents(queue: QueuedOperation[]): EventOp[] {
  const run: EventOp[] = [];
  for (const op of queue) {
    if (op.type !== 'event' || run.length >= EVENT_BATCH_MAX) break;
    run.push(op);
  }
  return run;
}

/** Kullanıcı/abonelik kimliği gerektiren işlemler (kimlik yokken sıralarını koruyarak beklerler). */
export function needsIdentity(op: QueuedOperation): boolean {
  switch (op.type) {
    case 'tags':
    case 'properties':
    case 'alias_add':
    case 'alias_remove':
    case 'preferences':
    case 'event':
    case 'event_batch':
      return true;
    default:
      return false;
  }
}

/** Kullanıcı (ve abonelik) oluşturabilen işlemler: başarıyla işlenince bekleyen işlemler yeniden denenir. */
export function createsIdentity(op: QueuedOperation): boolean {
  return op.type === 'contact_add';
}

export type OperationHandler = (op: QueuedOperation) => Promise<void>;

export interface OfflineQueueOptions {
  /** Kalıcı olarak reddedilip atılan işlem (SDK hata raporu için). */
  onRejected?: (op: QueuedOperation, err: ApiError) => void;
  /** true iken flush hiçbir şey göndermez (ör. gizlilik onayı bekleniyor); işlemler kuyrukta kalır. */
  isPaused?: () => boolean;
}

/**
 * Çevrimdışı kuyruk: işlemler sırayla, kalıcı olarak saklanır; bağlantı gelince flush edilir.
 * Yeniden denenemez hatalarda (4xx) işlem atılır ve loglanır; yeniden denenebilir hatada flush durur.
 * Kimlik bekleyen işlem (bkz. `AWAITING_IDENTITY_CODES`) flush'ı kilitlemez: o ve sonraki kimlik gerektiren
 * işlemler sıralarıyla bekler, diğer işlemler (kullanıcıyı oluşturan `contact_add` dahil) işlenmeye devam eder.
 */
export class OfflineQueue {
  private flushing = false;
  private readonly onRejected?: (op: QueuedOperation, err: ApiError) => void;
  private readonly isPaused: () => boolean;

  constructor(
    private readonly store: StateStore,
    private readonly handler: OperationHandler,
    private readonly logger: Logger,
    options: OfflineQueueOptions | ((op: QueuedOperation, err: ApiError) => void) = {},
  ) {
    // Geriye uyum: dördüncü parametre eskiden yalnızca `onRejected` geri çağrısıydı.
    const opts = typeof options === 'function' ? { onRejected: options } : options;
    this.onRejected = opts.onRejected;
    this.isPaused = opts.isPaused ?? (() => false);
  }

  get size(): number {
    return this.store.get().queue.length;
  }

  enqueue(op: QueuedOperation): void {
    const queue = [...this.store.get().queue, op];
    // Aynı türden ardışık tag/property yamaları birleştirilir (idempotent merge-patch).
    const merged = mergeTail(queue);
    this.store.update({ queue: merged.slice(-MAX_QUEUE) });
  }

  /**
   * Kuyruğu baştan sona işler. İlk genel yeniden denenebilir hatada durur ve false döner; kimlik bekleyen
   * işlemler kaldıysa da false döner. Duraklatılmışsa (onay yok) hiçbir istek yapılmaz.
   */
  async flush(): Promise<boolean> {
    if (this.flushing || this.isPaused()) return false;
    this.flushing = true;
    try {
      // Kimlik bekleyen (atlanan) işlemler; bellekteki nesne kimliğiyle izlenir.
      const waiting = new Set<QueuedOperation>();
      for (;;) {
        if (this.isPaused()) return false;
        const queue = this.store.get().queue;
        const start = queue.findIndex(
          (op) => !waiting.has(op) && !(waiting.size > 0 && needsIdentity(op)),
        );
        if (start < 0) return waiting.size === 0;
        const head = queue[start]!;
        // Ardışık olaylar tek istekte gönderilir (docs/plan/09 Faz 8 "SDK batch").
        const events = head.type === 'event' ? leadingEvents(queue.slice(start)) : [];
        const unit: QueuedOperation =
          events.length > 1 ? { type: 'event_batch', events, at: head.at } : head;
        const consumed: QueuedOperation[] = events.length > 1 ? events : [head];
        try {
          await this.handler(unit);
        } catch (err) {
          if (err instanceof ApiError && !err.retryable) {
            this.logger.warn('kuyruktaki işlem reddedildi, atılıyor', unit.type, err.code);
            this.onRejected?.(unit, err);
          } else if (err instanceof ApiError && AWAITING_IDENTITY_CODES.has(err.code)) {
            this.logger.debug('işlem kimlik bekliyor, kuyrukta tutuluyor', unit.type, err.code);
            for (const op of consumed) waiting.add(op);
            continue;
          } else {
            this.logger.debug('flush durdu (geçici hata)', unit.type);
            return false;
          }
        }
        // İşlenen işlemler nesne kimliğiyle çıkarılır: istek sürerken eklenen/birleştirilen işlemler korunur.
        const done = new Set(consumed);
        this.store.update({ queue: this.store.get().queue.filter((op) => !done.has(op)) });
        // Kimlik oluşmuş olabilir: bekleyen işlemler özgün sıralarıyla yeniden denenir.
        if (waiting.size > 0 && createsIdentity(head)) waiting.clear();
      }
    } finally {
      this.flushing = false;
    }
  }

  clear(): void {
    this.store.update({ queue: [] });
  }
}

function mergeTail(queue: QueuedOperation[]): QueuedOperation[] {
  if (queue.length < 2) return queue;
  const last = queue[queue.length - 1]!;
  const prev = queue[queue.length - 2]!;
  if (last.type === 'tags' && prev.type === 'tags') {
    return [...queue.slice(0, -2), { type: 'tags', tags: { ...prev.tags, ...last.tags }, at: last.at }];
  }
  if (last.type === 'properties' && prev.type === 'properties') {
    return [...queue.slice(0, -2), { type: 'properties', properties: { ...prev.properties, ...last.properties }, at: last.at }];
  }
  return queue;
}
