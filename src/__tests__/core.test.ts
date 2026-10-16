import { describe, expect, it, vi } from 'vitest';
import { ApiError, SdkApi } from '../core/api.js';
import { Logger } from '../core/logger.js';
import { OfflineQueue } from '../core/queue.js';
import { MemoryStore, StateStore } from '../core/storage.js';
import type { QueuedOperation } from '../core/types.js';
import { parsePushPayload, resolveClickUrl, toNotificationOptions } from '../sw/payload.js';

const logger = new Logger('silent');

describe('StateStore', () => {
  it('varsayılanla başlar, günceller ve kalıcı yazar', () => {
    const mem = new MemoryStore();
    const s = new StateStore('app_1', mem);
    expect(s.get().subscriptionId).toBeNull();
    s.update({ subscriptionId: 'sub_1', tags: { a: '1' } });
    const again = new StateStore('app_1', mem);
    expect(again.get()).toMatchObject({ subscriptionId: 'sub_1', tags: { a: '1' } });
    again.reset({ consentGiven: true });
    expect(again.get()).toMatchObject({ subscriptionId: null, consentGiven: true, queue: [] });
  });

  it('bozuk veri varsayılanla değiştirilir', () => {
    const mem = new MemoryStore();
    mem.setItem('hs:app_1', '{bozuk');
    expect(new StateStore('app_1', mem).get().tags).toEqual({});
  });
});

describe('OfflineQueue', () => {
  const op = (type: 'event', name: string): QueuedOperation => ({
    type,
    name,
    occurredAt: 'x',
    at: 1,
  });

  it('sırayla işler, geçici hatada durur, kalıcı hatada atar', async () => {
    // Olay dışı işlemler tek tek işlenir (olaylar toplu gönderilir, ayrı test).
    const alias = (label: string): QueuedOperation => ({ type: 'alias_remove', label, at: 1 });
    const store = new StateStore('app_q', new MemoryStore());
    const seen: string[] = [];
    let failOnce = true;
    const q = new OfflineQueue(
      store,
      async (o) => {
        if (o.type !== 'alias_remove') return;
        if (o.label === 'transient' && failOnce) {
          failOnce = false;
          throw new ApiError(503, 'HS_SERVICE_UNAVAILABLE', 'x');
        }
        if (o.label === 'bad') throw new ApiError(400, 'HS_VALIDATION_ERROR', 'x');
        seen.push(o.label);
      },
      logger,
    );
    q.enqueue(alias('a'));
    q.enqueue(alias('transient'));
    q.enqueue(alias('bad'));
    q.enqueue(alias('b'));
    expect(await q.flush()).toBe(false);
    expect(seen).toEqual(['a']);
    expect(q.size).toBe(3);
    expect(await q.flush()).toBe(true);
    expect(seen).toEqual(['a', 'transient', 'b']);
    expect(q.size).toBe(0);
  });

  it('ardışık olayları tek toplu işlemde gönderir (en fazla 100)', async () => {
    const store = new StateStore('app_b', new MemoryStore());
    const units: { type: string; count: number }[] = [];
    const q = new OfflineQueue(
      store,
      async (o) => {
        units.push({ type: o.type, count: o.type === 'event_batch' ? o.events.length : 1 });
      },
      logger,
    );
    for (let i = 0; i < 150; i++) q.enqueue(op('event', `e${i}`));
    q.enqueue({ type: 'tags', tags: { a: '1' }, at: 2 });
    q.enqueue(op('event', 'tek'));
    expect(await q.flush()).toBe(true);
    expect(units).toEqual([
      { type: 'event_batch', count: 100 },
      { type: 'event_batch', count: 50 },
      { type: 'tags', count: 1 },
      { type: 'event', count: 1 },
    ]);
    expect(q.size).toBe(0);
  });

  it('toplu olay geçici hatada kuyrukta kalır', async () => {
    const store = new StateStore('app_c', new MemoryStore());
    let fail = true;
    const q = new OfflineQueue(
      store,
      async () => {
        if (fail) {
          fail = false;
          throw new ApiError(503, 'HS_SERVICE_UNAVAILABLE', 'x');
        }
      },
      logger,
    );
    q.enqueue(op('event', 'a'));
    q.enqueue(op('event', 'b'));
    expect(await q.flush()).toBe(false);
    expect(q.size).toBe(2);
    expect(await q.flush()).toBe(true);
    expect(q.size).toBe(0);
  });

  it('ardışık tag yamalarını birleştirir', () => {
    const store = new StateStore('app_m', new MemoryStore());
    const q = new OfflineQueue(store, async () => undefined, logger);
    q.enqueue({ type: 'tags', tags: { a: '1' }, at: 1 });
    q.enqueue({ type: 'tags', tags: { b: '2', a: null }, at: 2 });
    expect(store.get().queue).toEqual([{ type: 'tags', tags: { a: null, b: '2' }, at: 2 }]);
  });
});

describe('SdkApi', () => {
  it('5xx/429 yeniden dener, 4xx denemez, ağ hatasında NETWORK', async () => {
    const calls: string[] = [];
    let n = 0;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${input}`);
      n++;
      if (n === 1)
        return new Response('{"error":{"code":"HS_RATE_LIMITED"}}', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      if (n === 2) return new Response('', { status: 503 });
      return new Response('{"ok":true}', { status: 200 });
    });
    const api = new SdkApi({
      baseUrl: 'https://api.test/',
      appId: 'app_1',
      fetch: fetchMock as unknown as typeof fetch,
      logger,
      sleep: async () => undefined,
    });
    expect(await api.request('POST', '/events', { x: 1 })).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe('POST https://api.test/sdk/v1/apps/app_1/events');

    const bad = new SdkApi({
      baseUrl: 'https://api.test',
      appId: 'app_1',
      fetch: async () =>
        new Response('{"error":{"code":"HS_NOT_FOUND","message":"yok"}}', { status: 404 }),
      logger,
      sleep: async () => undefined,
    });
    await expect(bad.request('GET', '/config')).rejects.toMatchObject({
      status: 404,
      code: 'HS_NOT_FOUND',
      retryable: false,
    });

    const down = new SdkApi({
      baseUrl: 'https://api.test',
      appId: 'app_1',
      fetch: async () => {
        throw new TypeError('failed to fetch');
      },
      logger,
      sleep: async () => undefined,
      maxRetries: 1,
    });
    await expect(down.request('GET', '/config')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK',
      retryable: true,
    });
  });
});

describe('push payload', () => {
  it('JSON payload ayrıştırılır ve bildirim seçeneklerine dönüşür', () => {
    const p = parsePushPayload(
      JSON.stringify({
        title: 'Selam',
        body: 'Gövde',
        url: 'https://x.y',
        tag: 't',
        actions: [
          { action: 'open', title: 'Aç', url: 'https://x.y/a' },
          { action: 'b', title: 'B' },
          { action: 'c', title: 'C' },
        ],
        hs: { delivery_id: 'dlv_1' },
      }),
    );
    expect(p.actions).toHaveLength(2);
    const n = toNotificationOptions(p);
    expect(n.title).toBe('Selam');
    expect(n.options.body).toBe('Gövde');
    expect((n.options.data as { hs: { delivery_id: string } }).hs.delivery_id).toBe('dlv_1');
    expect(resolveClickUrl(n.options.data as never, 'open')).toBe('https://x.y/a');
    expect(resolveClickUrl(n.options.data as never, 'b')).toBe('https://x.y');
    expect(resolveClickUrl(n.options.data as never, undefined)).toBe('https://x.y');
  });

  it('düz metin ve boş payload', () => {
    expect(parsePushPayload('merhaba')).toEqual({ title: '', body: 'merhaba' });
    expect(toNotificationOptions(parsePushPayload(null)).title).toBe('Pushizo');
  });
});
