import type { Logger } from './logger.js';
import { ApiError } from './api.js';
import type { StateStore } from './storage.js';
import type { QueuedOperation } from './types.js';

const MAX_QUEUE = 500;
/** Tek istekte gönderilen en fazla olay (SDK API sınırı: 100). */
export const EVENT_BATCH_MAX = 100;

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

export type OperationHandler = (op: QueuedOperation) => Promise<void>;

/**
 * Çevrimdışı kuyruk: işlemler sırayla, kalıcı olarak saklanır; bağlantı gelince flush edilir.
 * Yeniden denenemez hatalarda (4xx) işlem atılır ve loglanır; yeniden denenebilir hatada flush durur.
 */
export class OfflineQueue {
  private flushing = false;

  constructor(
    private readonly store: StateStore,
    private readonly handler: OperationHandler,
    private readonly logger: Logger,
    /** Kalıcı olarak reddedilip atılan işlem (SDK hata raporu için). */
    private readonly onRejected?: (op: QueuedOperation, err: ApiError) => void,
  ) {}

  get size(): number {
    return this.store.get().queue.length;
  }

  enqueue(op: QueuedOperation): void {
    const queue = [...this.store.get().queue, op];
    // Aynı türden ardışık tag/property yamaları birleştirilir (idempotent merge-patch).
    const merged = mergeTail(queue);
    this.store.update({ queue: merged.slice(-MAX_QUEUE) });
  }

  /** Kuyruğu baştan sona işler; ilk yeniden denenebilir hatada durur ve false döner. */
  async flush(): Promise<boolean> {
    if (this.flushing) return false;
    this.flushing = true;
    try {
      while (this.store.get().queue.length > 0) {
        const queue = this.store.get().queue;
        const head = queue[0];
        if (!head) break;
        // Ardışık olaylar tek istekte gönderilir (docs/plan/09 Faz 8 "SDK batch").
        const events = head.type === 'event' ? leadingEvents(queue) : [];
        const unit: QueuedOperation = events.length > 1 ? { type: 'event_batch', events, at: head.at } : head;
        const consumed = events.length > 1 ? events.length : 1;
        try {
          await this.handler(unit);
        } catch (err) {
          if (err instanceof ApiError && !err.retryable) {
            this.logger.warn('kuyruktaki işlem reddedildi, atılıyor', unit.type, err.code);
            this.onRejected?.(unit, err);
          } else {
            this.logger.debug('flush durdu (geçici hata)', unit.type);
            return false;
          }
        }
        this.store.update({ queue: this.store.get().queue.slice(consumed) });
      }
      return true;
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
