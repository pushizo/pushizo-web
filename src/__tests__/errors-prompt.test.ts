import { describe, expect, it } from 'vitest';
import { pickLocalized, safeAccentColor, slidedownFromRemote } from '../browser/prompts.js';
import { ApiError, type RemotePromptConfig } from '../core/api.js';
import { ErrorReporter, type SdkErrorItem } from '../core/errors.js';
import { isJsonObjectText } from '../sw/payload.js';

describe('ErrorReporter (SDK hata raporları)', () => {
  it('tekrarları ve ağ hatalarını atlar, oturum sınırına uyar, tokenları maskeler', async () => {
    const sent: SdkErrorItem[][] = [];
    const reporter = new ErrorReporter({
      sdkVersion: '0.1.0',
      maxPerSession: 3,
      flushDelayMs: 60_000,
      send: async (body) => {
        sent.push(body.errors);
      },
    });
    expect(
      reporter.record(
        'registration_failed',
        'kayıt başarısız',
        new ApiError(500, 'HS_INTERNAL', 'x'),
        {
          subscriptionId: 'sub_1',
        },
      ),
    ).toBe(true);
    expect(
      reporter.record(
        'registration_failed',
        'kayıt başarısız',
        new ApiError(500, 'HS_INTERNAL', 'x'),
      ),
    ).toBe(false);
    expect(reporter.record('x', 'ağ', new ApiError(0, 'NETWORK', 'offline'))).toBe(false);
    expect(reporter.record('x', 'ağ', new TypeError('Failed to fetch'))).toBe(false);
    const token = 'a'.repeat(80);
    expect(reporter.record('b', `token ${token}`, undefined, { context: { op: 'tags' } })).toBe(
      true,
    );
    expect(reporter.record('c', 'üçüncü', new Error('kişisel@ornek.com'))).toBe(true);
    expect(reporter.record('d', 'limit aşıldı')).toBe(false);
    await reporter.flush();
    expect(sent).toHaveLength(1);
    const [first, second, third] = sent[0]!;
    expect(first).toMatchObject({
      level: 'error',
      platform: 'web',
      code: 'registration_failed',
      message: 'kayıt başarısız: HTTP 500 HS_INTERNAL',
      subscription_id: 'sub_1',
    });
    expect(second!.message).not.toContain(token);
    expect(second!.context).toEqual({ op: 'tags' });
    // Ham hata mesajı (PII içerebilir) gönderilmez, yalnızca hata türü.
    expect(third!.message).toBe('üçüncü: Error');
  });

  it('gönderim hatası yutulur ve yeniden raporlanmaz; onay yokken kayıt alınmaz', async () => {
    let calls = 0;
    const reporter = new ErrorReporter({
      sdkVersion: '0.1.0',
      flushDelayMs: 60_000,
      send: async () => {
        calls++;
        throw new ApiError(500, 'HS_INTERNAL', 'x');
      },
    });
    reporter.record('a', 'bir');
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(reporter.pendingCount).toBe(0);
    reporter.setEnabled(false);
    expect(reporter.record('b', 'iki')).toBe(false);
  });
});

describe('dashboard istemi (config.web.prompt)', () => {
  const prompt: RemotePromptConfig = {
    enabled: true,
    type: 'slidedown',
    delaySeconds: 5,
    pageViews: 2,
    scrollPercent: 40,
    texts: { tr: { title: 'Haberdar olun', accept: 'Evet' }, en: { title: 'Stay tuned' } },
    categories: [
      { tag: 'news', label: { tr: 'Haberler', en: 'News' } },
      { tag: 'deals', label: { de: 'Angebote' } },
    ],
    accentColor: '#ff0000',
  };

  it('geçerli dile göre slidedown seçeneklerine dönüşür (en/tr/ilk değer yedeği)', () => {
    expect(slidedownFromRemote(prompt, 'tr-TR')).toMatchObject({
      delaySeconds: 5,
      pageViews: 2,
      scrollPercent: 40,
      title: 'Haberdar olun',
      acceptText: 'Evet',
      categories: [
        { tag: 'news', label: 'Haberler' },
        { tag: 'deals', label: 'Angebote' },
      ],
      accentColor: '#ff0000',
    });
    expect(slidedownFromRemote(prompt, 'fr').title).toBe('Stay tuned');
    expect(pickLocalized({ tr: 'a' }, 'fr')).toBe('a');
    expect(pickLocalized(undefined, 'tr')).toBeUndefined();
  });

  it('vurgu rengi yalnızca #rrggbb biçiminde kabul edilir', () => {
    expect(safeAccentColor('#12abEF')).toBe('#12abEF');
    expect(safeAccentColor('red;background:url(x)')).toBeUndefined();
    expect(safeAccentColor(undefined)).toBeUndefined();
  });
});

describe('SW payload doğrulaması', () => {
  it('JSON nesnesi tespiti', () => {
    expect(isJsonObjectText('{"title":"x"}')).toBe(true);
    expect(isJsonObjectText('[1]')).toBe(false);
    expect(isJsonObjectText('düz metin')).toBe(false);
  });
});
