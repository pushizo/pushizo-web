import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_MAX_AGE_MS,
  FEEDBACK_QUEUE_MAX,
  FeedbackQueue,
  type FeedbackItem,
  type FeedbackStore,
} from '../sw/feedback-queue.js';
import { safeClickUrl } from '../sw/payload.js';

/** Bellek içi depo: IndexedDB uygulamasıyla aynı arayüz (anahtar: istek adresi). */
class MemoryFeedbackStore implements FeedbackStore {
  readonly items = new Map<string, FeedbackItem>();
  async list(): Promise<FeedbackItem[]> {
    return [...this.items.values()];
  }
  async put(item: FeedbackItem): Promise<void> {
    this.items.set(item.url, item);
  }
  async delete(url: string): Promise<void> {
    this.items.delete(url);
  }
}

const noSleep = async () => undefined;

function harness(status: () => number | 'offline', now = () => 1_000_000) {
  const store = new MemoryFeedbackStore();
  const sent: { url: string; body: unknown }[] = [];
  const queue = new FeedbackQueue({
    store,
    now,
    sleep: noSleep,
    send: async (url, init) => {
      const s = status();
      if (s === 'offline') throw new TypeError('Failed to fetch');
      sent.push({ url, body: JSON.parse(init.body as string) as unknown });
      return new Response('{}', { status: s });
    },
  });
  return { store, sent, queue };
}

describe('safeClickUrl', () => {
  const origin = 'https://shop.example';

  it('http/https mutlak adresleri ve aynı origin göreli adresleri kabul eder', () => {
    expect(safeClickUrl('https://other.example/a?b=1', origin)).toBe('https://other.example/a?b=1');
    expect(safeClickUrl('http://shop.example/x', origin)).toBe('http://shop.example/x');
    expect(safeClickUrl('/sale?x=1', origin)).toBe('https://shop.example/sale?x=1');
    expect(safeClickUrl('cart', origin)).toBe('https://shop.example/cart');
    expect(safeClickUrl('  HTTPS://Shop.Example/Up  ', origin)).toBe('https://shop.example/Up');
  });

  it('tehlikeli şemaları, origin dışına çıkan göreli adresleri ve boş değeri reddeder', () => {
    for (const raw of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'myapp://deep',
      '//evil.example/x',
      '/\\evil.example/x',
      '',
      '   ',
      undefined,
      null,
    ])
      expect(safeClickUrl(raw, origin), String(raw)).toBeUndefined();
  });
});

describe('FeedbackQueue (SW kalıcı geri bildirim kuyruğu)', () => {
  it('başarılı gönderim kuyruğa yazılmaz; 4xx kalıcı ret de yazılmaz', async () => {
    let code = 200;
    const { store, sent, queue } = harness(() => code);
    expect(await queue.send('https://api/x/received')).toBe(true);
    code = 404;
    expect(await queue.send('https://api/y/opened', { button_id: 'b' })).toBe(false);
    expect(sent).toHaveLength(2);
    expect(store.items.size).toBe(0);
  });

  it('geçici hatada kalıcı kuyruğa yazar; drain bağlantı gelince gönderir ve siler', async () => {
    let state: number | 'offline' = 'offline';
    const { store, sent, queue } = harness(() => state);
    expect(await queue.send('https://api/d1/opened', { button_id: 'buy' })).toBe(false);
    state = 503;
    expect(await queue.send('https://api/d2/received')).toBe(false);
    expect([...store.items.values()]).toEqual([
      { url: 'https://api/d1/opened', body: { button_id: 'buy' }, at: 1_000_000, attempts: 1 },
      { url: 'https://api/d2/received', body: {}, at: 1_000_000, attempts: 1 },
    ]);

    // Hâlâ çevrimdışı: tek deneme, deneme sayısı artar, öğe kalır.
    state = 'offline';
    await queue.drain();
    expect(store.items.get('https://api/d1/opened')!.attempts).toBe(2);
    expect(store.items.size).toBe(2);

    state = 200;
    sent.length = 0;
    await queue.drain();
    expect(sent).toEqual([
      { url: 'https://api/d1/opened', body: { button_id: 'buy' } },
      { url: 'https://api/d2/received', body: {} },
    ]);
    expect(store.items.size).toBe(0);
  });

  it('süresi geçmiş öğe gönderilmeden atılır; eşzamanlı drain tek tur çalışır', async () => {
    let now = 1_000_000;
    const { store, sent, queue } = harness(
      () => 200,
      () => now,
    );
    await store.put({
      url: 'https://api/old/received',
      body: {},
      at: now - FEEDBACK_MAX_AGE_MS - 1,
      attempts: 1,
    });
    await store.put({ url: 'https://api/new/received', body: {}, at: now, attempts: 1 });
    now += 1;
    await Promise.all([queue.drain(), queue.drain()]);
    expect(sent.map((s) => s.url)).toEqual(['https://api/new/received']);
    expect(store.items.size).toBe(0);
  });

  it('kuyruk sınırı aşılınca en eski öğe atılır; depo hatası gönderimi bozmaz', async () => {
    let t = 0;
    const { store, queue } = harness(
      () => 'offline',
      () => ++t,
    );
    for (let i = 0; i < FEEDBACK_QUEUE_MAX + 1; i++) await queue.send(`https://api/d${i}/received`);
    expect(store.items.size).toBe(FEEDBACK_QUEUE_MAX);
    expect(store.items.has('https://api/d0/received')).toBe(false);
    expect(store.items.has(`https://api/d${FEEDBACK_QUEUE_MAX}/received`)).toBe(true);

    const errors: unknown[] = [];
    const broken = new FeedbackQueue({
      store: {
        list: async () => {
          throw new Error('idb kapalı');
        },
        put: async () => {
          throw new Error('idb kapalı');
        },
        delete: async () => undefined,
      },
      sleep: noSleep,
      send: async () => {
        throw new TypeError('offline');
      },
      onStoreError: (err) => errors.push(err),
    });
    await expect(broken.send('https://api/z/received')).resolves.toBe(false);
    await expect(broken.drain()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});
