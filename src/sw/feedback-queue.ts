import { deliverFeedback } from './payload.js';

/** Gönderilemeyen teslimat geri bildirimi (`received`/`opened`/`dismissed`); anahtar istek adresidir. */
export interface FeedbackItem {
  url: string;
  body: Record<string, unknown>;
  /** İlk deneme anı (epoch ms). */
  at: number;
  /** Bugüne kadarki gönderim turu sayısı. */
  attempts: number;
}

/** Kalıcı geri bildirim deposu (service worker'da IndexedDB; testlerde bellek içi). */
export interface FeedbackStore {
  list(): Promise<FeedbackItem[]>;
  put(item: FeedbackItem): Promise<void>;
  delete(url: string): Promise<void>;
}

/** Kuyrukta tutulan en fazla geri bildirim; dolunca en eskisi atılır. */
export const FEEDBACK_QUEUE_MAX = 200;
/** Bu süreden eski geri bildirim artık anlamlı değildir, gönderilmeden atılır. */
export const FEEDBACK_MAX_AGE_MS = 7 * 86_400_000;
/** Kuyruktan en fazla bu kadar tur denenir. */
export const FEEDBACK_MAX_ATTEMPTS = 25;

export type FeedbackSender = (url: string, init: RequestInit) => Promise<Response>;

export interface FeedbackQueueOptions {
  store: FeedbackStore;
  send: FeedbackSender;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Depolama hatası (IndexedDB kapalı/dolu); geri bildirim akışını durdurmaz. */
  onStoreError?: (err: unknown) => void;
}

/**
 * Teslimat geri bildirimi kuyruğu (B-13): önce geri çekilmeyle doğrudan gönderilir; geçici hatada kalıcı
 * depoya yazılır ve sonraki `push`/`activate`/`notificationclick` olaylarında `drain()` ile yeniden denenir.
 * Hiçbir yöntem hata fırlatmaz.
 */
export class FeedbackQueue {
  private draining: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: FeedbackQueueOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Geri bildirimi gönderir; yeniden denenebilir hatada kuyruğa yazar. Gönderildiyse true. */
  async send(url: string, body: Record<string, unknown> = {}): Promise<boolean> {
    const result = await deliverFeedback(
      (init) => this.options.send(url, init),
      body,
      this.options.sleep,
    );
    if (result === 'retry') await this.save({ url, body, at: this.now(), attempts: 1 });
    return result === 'sent';
  }

  /** Kuyruktaki geri bildirimleri birer kez dener; eşzamanlı çağrılar aynı turu bekler. */
  drain(): Promise<void> {
    this.draining ??= this.drainOnce().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    const items = await this.guard(() => this.options.store.list(), []);
    for (const item of items.sort((a, b) => a.at - b.at)) {
      if (this.now() - item.at > FEEDBACK_MAX_AGE_MS || item.attempts >= FEEDBACK_MAX_ATTEMPTS) {
        await this.guard(() => this.options.store.delete(item.url), undefined);
        continue;
      }
      // Kuyruktan tek deneme: art arda bekleme yok, sonraki olayda yeniden denenir.
      const result = await deliverFeedback(
        (init) => this.options.send(item.url, init),
        item.body,
        this.options.sleep,
        [],
      );
      if (result === 'retry') {
        await this.guard(
          () => this.options.store.put({ ...item, attempts: item.attempts + 1 }),
          undefined,
        );
        // Ağ hâlâ yok: kalan öğeler de büyük olasılıkla başarısız olur, sonraki olaya bırakılır.
        return;
      }
      await this.guard(() => this.options.store.delete(item.url), undefined);
    }
  }

  private async save(item: FeedbackItem): Promise<void> {
    await this.guard(async () => {
      const items = await this.options.store.list();
      const overflow = items.length - FEEDBACK_QUEUE_MAX + 1;
      if (overflow > 0 && !items.some((i) => i.url === item.url))
        for (const old of items.sort((a, b) => a.at - b.at).slice(0, overflow))
          await this.options.store.delete(old.url);
      await this.options.store.put(item);
    }, undefined);
  }

  private async guard<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.options.onStoreError?.(err);
      return fallback;
    }
  }
}

const DB_NAME = 'hs-sw';

/** IndexedDB hata nesnesi (DOMException) yoksa genel hata üretir. */
function idbError(error: DOMException | null): Error {
  return error ?? new Error('IndexedDB işlemi başarısız');
}
const STORE_NAME = 'feedback';

/** Service worker kapsamında IndexedDB tabanlı geri bildirim deposu (`hs-sw` veritabanı). */
export class IdbFeedbackStore implements FeedbackStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'url' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(idbError(request.error));
    }).catch((err: unknown) => {
      // Açılamadıysa sonraki çağrı yeniden dener.
      this.db = null;
      throw err;
    });
    return this.db;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = fn(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(idbError(tx.error));
      tx.onabort = () => reject(idbError(tx.error));
    });
  }

  list(): Promise<FeedbackItem[]> {
    return this.run('readonly', (store) => store.getAll() as IDBRequest<FeedbackItem[]>);
  }

  async put(item: FeedbackItem): Promise<void> {
    await this.run('readwrite', (store) => store.put(item));
  }

  async delete(url: string): Promise<void> {
    await this.run('readwrite', (store) => store.delete(url));
  }
}
