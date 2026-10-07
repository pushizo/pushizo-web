import { describe, expect, it } from 'vitest';
import { categoriesToTags, scrollPercentOf } from '../browser/prompts.js';
import { subscriptionToToken } from '../browser/push.js';
import { SdkApi } from '../core/api.js';
import { assertAliasLabel, normalizeAliases } from '../core/identity.js';
import { Logger } from '../core/logger.js';
import { MemoryStore, StateStore } from '../core/storage.js';
import { digest, syncPushToken } from '../core/token.js';
import {
  deliveryIdOf,
  messageIdOf,
  parsePushPayload,
  postWithRetry,
  toNotificationOptions,
} from '../sw/payload.js';

const logger = new Logger('silent');

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function apiWith(handler: (call: Call) => Response): { api: SdkApi; calls: Call[] } {
  const calls: Call[] = [];
  const api = new SdkApi({
    baseUrl: 'https://api.test',
    appId: 'app_1',
    logger,
    sleep: async () => undefined,
    fetch: (async (input: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: input,
        body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
      };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch,
  });
  return { api, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const registered = {
  subscription_id: 'sub_1',
  user_id: 'usr_1',
  external_id: null,
  status: 'subscribed',
  created: true,
};

describe('push token yenileme (syncPushToken)', () => {
  it('kayıt yoksa POST ile abonelik oluşturur ve token özetini saklar', async () => {
    const store = new StateStore('app_t1', new MemoryStore());
    const { api, calls } = apiWith(() => json(200, registered));
    const result = await syncPushToken(api, store, {
      token: 'tok_a',
      endpoint: 'https://push.example/a',
      device: { sdk_platform: 'web' },
    });
    expect(result).toBe('created');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.test/sdk/v1/apps/app_1/subscriptions',
      body: { channel: 'web_push', token: 'tok_a', user: {}, ownership_proof: true },
    });
    expect(store.get()).toMatchObject({
      subscriptionId: 'sub_1',
      userId: 'usr_1',
      tokenHash: await digest('tok_a'),
      pushEndpoint: 'https://push.example/a',
    });
  });

  it('token değişince yeni abonelik açmaz, mevcut aboneliği eski token özetiyle (sahiplik kanıtı) PATCH eder', async () => {
    const store = new StateStore('app_t2', new MemoryStore());
    store.update({ subscriptionId: 'sub_1', userId: 'usr_1', tokenHash: await digest('tok_a') });
    const { api, calls } = apiWith(() => json(200, { id: 'sub_1', status: 'subscribed' }));
    const result = await syncPushToken(api, store, {
      token: 'tok_b',
      endpoint: 'https://push.example/b',
      device: { sdk_version: '1.0.0' },
    });
    expect(result).toBe('updated');
    expect(calls).toEqual([
      {
        method: 'PATCH',
        url: 'https://api.test/sdk/v1/apps/app_1/subscriptions/sub_1',
        body: { token: 'tok_b', device: { sdk_version: '1.0.0' }, token_hash: await digest('tok_a') },
      },
    ]);
    expect(store.get().subscriptionId).toBe('sub_1');
    expect(store.get().tokenHash).toBe(await digest('tok_b'));
    expect(store.get().pushEndpoint).toBe('https://push.example/b');
  });

  it('token aynıysa istek göndermez', async () => {
    const store = new StateStore('app_t3', new MemoryStore());
    store.update({ subscriptionId: 'sub_1', tokenHash: await digest('tok_a') });
    const { api, calls } = apiWith(() => json(500, {}));
    expect(await syncPushToken(api, store, { token: 'tok_a', endpoint: null, device: {} })).toBe(
      'unchanged',
    );
    expect(calls).toHaveLength(0);
  });

  it('abonelik sunucuda silinmişse (404) POST ile yeniden oluşturur; kimlik hash ile gönderilir', async () => {
    const store = new StateStore('app_t4', new MemoryStore());
    store.update({
      subscriptionId: 'sub_old',
      externalId: 'u1',
      identityHash: 'h'.repeat(64),
      tokenHash: await digest('tok_a'),
    });
    const { api, calls } = apiWith((call) =>
      call.method === 'PATCH'
        ? json(404, { error: { code: 'HS_NOT_FOUND', message: 'yok' } })
        : json(200, { ...registered, subscription_id: 'sub_new', external_id: 'u1' }),
    );
    expect(await syncPushToken(api, store, { token: 'tok_b', endpoint: null, device: {} })).toBe(
      'created',
    );
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
    expect(calls[1]!.body).toMatchObject({
      user: { external_id: 'u1', identity_hash: 'h'.repeat(64) },
    });
    expect(store.get().subscriptionId).toBe('sub_new');
  });

  it('geçici hata yukarı fırlatılır (kayıt değişmez)', async () => {
    const store = new StateStore('app_t5', new MemoryStore());
    store.update({ subscriptionId: 'sub_1', tokenHash: await digest('tok_a') });
    const { api } = apiWith(() => json(503, {}));
    await expect(
      syncPushToken(api, store, { token: 'tok_b', endpoint: null, device: {} }),
    ).rejects.toMatchObject({ status: 503 });
    expect(store.get().tokenHash).toBe(await digest('tok_a'));
  });

  it('gerçek abonelik yoksa token üretilmez (boş/sahte token gönderilmez)', () => {
    expect(subscriptionToToken(null)).toBeNull();
    expect(subscriptionToToken({ endpoint: 'https://push.example/x' })).toBeNull();
    expect(subscriptionToToken({ endpoint: '', keys: { p256dh: 'p', auth: 'a' } })).toBeNull();
    expect(
      JSON.parse(
        subscriptionToToken({
          endpoint: 'https://push.example/x',
          keys: { p256dh: 'p', auth: 'a' },
        })!,
      ),
    ).toEqual({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } });
  });
});

describe('alias doğrulama', () => {
  it('geçerli alias haritası kırpılarak döner', () => {
    expect(normalizeAliases({ crm_id: ' 42 ', shop_1: 'x' })).toEqual({
      crm_id: '42',
      shop_1: 'x',
    });
  });

  it('geçersiz/ayrılmış etiketler ve boş değerler reddedilir', () => {
    expect(() => assertAliasLabel('CRM')).toThrow();
    expect(() => assertAliasLabel('external_id')).toThrow();
    expect(() => assertAliasLabel('hs_id')).toThrow();
    expect(() => normalizeAliases({})).toThrow();
    expect(() => normalizeAliases({ crm_id: '  ' })).toThrow();
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, 'v']));
    expect(() => normalizeAliases(many)).toThrow();
  });
});

describe('push payload (yeni hs biçimi)', () => {
  it('dlv/msg/buttons ayrıştırılır, buttons aksiyonlara dönüşür', () => {
    const p = parsePushPayload(
      JSON.stringify({
        title: 'T',
        body: 'B',
        data: { order: '7' },
        hs: {
          dlv: 'dlv_1',
          delivery_id: 'dlv_1',
          msg: 'msg_1',
          url: 'https://x.y/n',
          buttons: [
            { id: 'track', title: 'Takip', url: 'https://x.y/t' },
            { id: 'later', title: 'Sonra' },
            { title: 'kimliksiz' },
          ],
        },
      }),
    );
    expect(deliveryIdOf(p.hs)).toBe('dlv_1');
    expect(messageIdOf(p.hs)).toBe('msg_1');
    expect(p.url).toBe('https://x.y/n');
    expect(p.data).toEqual({ order: '7' });
    expect(p.actions).toEqual([
      { action: 'track', title: 'Takip', icon: undefined, url: 'https://x.y/t' },
      { action: 'later', title: 'Sonra', icon: undefined, url: undefined },
    ]);
    expect(toNotificationOptions(p).options.actions).toHaveLength(2);
  });

  it('eski biçime geri düşer (delivery_id, üst düzey actions)', () => {
    const p = parsePushPayload(
      JSON.stringify({
        title: 'T',
        actions: [{ action: 'a', title: 'A' }],
        hs: { delivery_id: 'dlv_old', buttons: [{ id: 'x', title: 'X' }] },
      }),
    );
    expect(deliveryIdOf(p.hs)).toBe('dlv_old');
    expect(messageIdOf(p.hs)).toBeUndefined();
    expect(p.actions?.map((a) => a.action)).toEqual(['a']);
    expect(deliveryIdOf(undefined)).toBeUndefined();
  });
});

describe('postWithRetry (SW geri bildirimi)', () => {
  it('5xx/ağ hatasında en fazla 3 kez dener, 4xx tekrarlanmaz', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) throw new TypeError('offline');
      if (n === 2) return new Response('', { status: 503 });
      return new Response('{}', { status: 200 });
    };
    expect(await postWithRetry(flaky, {}, sleep)).toBe(true);
    expect(n).toBe(3);
    expect(waits).toEqual([500, 1500]);

    let m = 0;
    const down = async () => {
      m++;
      return new Response('', { status: 502 });
    };
    expect(await postWithRetry(down, undefined, sleep)).toBe(false);
    expect(m).toBe(3);

    let k = 0;
    const bad = async () => {
      k++;
      return new Response('', { status: 404 });
    };
    expect(await postWithRetry(bad, undefined, sleep)).toBe(false);
    expect(k).toBe(1);
  });
});

describe('slidedown yardımcıları', () => {
  it('kaydırma yüzdesi hesaplanır; kaydırılamayan sayfa %100 sayılır', () => {
    expect(scrollPercentOf(0, 800, 800)).toBe(100);
    expect(scrollPercentOf(0, 800, 1800)).toBe(0);
    expect(scrollPercentOf(500, 800, 1800)).toBe(50);
    expect(scrollPercentOf(5000, 800, 1800)).toBe(100);
  });

  it('kategori seçimi tag yamasına dönüşür', () => {
    const categories = [
      { tag: 'news', label: 'Haberler' },
      { tag: 'deals', label: 'Fırsatlar' },
    ];
    expect(categoriesToTags(categories, new Set(['deals']))).toEqual({ news: null, deals: '1' });
  });
});
