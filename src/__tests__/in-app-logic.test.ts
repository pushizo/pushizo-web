import { describe, expect, it } from 'vitest';
import {
  ContactValidationError,
  normalizeContact,
  normalizeEmail,
  normalizePhone,
} from '../core/contact.js';
import {
  frequencyAllows,
  matchesTriggerCondition,
  pickMessage,
  safeColor,
  safeDeeplink,
  safeHttpUrl,
  triggersMatch,
  type TriggerContext,
} from '../core/in-app-logic.js';
import type { InAppMessage, InAppTrigger } from '../core/types.js';

const ctx = (patch: Partial<TriggerContext> = {}): TriggerContext => ({
  sessionStart: false,
  screen: null,
  triggers: {},
  ...patch,
});

function message(patch: Partial<InAppMessage> = {}): InAppMessage {
  return {
    id: 'iam_1',
    priority: 0,
    triggers: [],
    display: {
      layout: 'modal',
      background_color: null,
      text_color: null,
      dismissible: true,
      auto_dismiss_seconds: null,
      blocks: [{ type: 'title', text: 'Merhaba' }],
    },
    remaining_impressions: 1,
    min_interval_seconds: 0,
    last_impression_at: null,
    end_at: null,
    stop_after_interaction: false,
    ...patch,
  };
}

describe('e-posta/SMS normalizasyonu', () => {
  it('e-posta kırpılır ve küçük harfe çevrilir; geçersiz adres null', () => {
    expect(normalizeEmail('  Ayşe.Kaya@Example.COM ')).toBe('ayşe.kaya@example.com');
    expect(normalizeEmail('a@b.co')).toBe('a@b.co');
    expect(normalizeEmail('eksik-at.example.com')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('a b@example.com')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(320)}@example.com`)).toBeNull();
  });

  it('telefon E.164 biçimine getirilir (boşluk, tire, parantez, nokta, 00 öneki)', () => {
    expect(normalizePhone('+90 532 123 45 67')).toBe('+905321234567');
    expect(normalizePhone('0090 (532) 123-45.67')).toBe('+905321234567');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('05321234567')).toBeNull();
    expect(normalizePhone('+0532')).toBeNull();
    expect(normalizePhone('+90532abc')).toBeNull();
  });

  it('geçersiz değerde anlamlı hata; mesajda adresin kendisi yer almaz', () => {
    expect(normalizeContact('email', 'X@Y.COM')).toBe('x@y.com');
    expect(() => normalizeContact('email', 'gizli-adres')).toThrow(ContactValidationError);
    try {
      normalizeContact('sms', '5551234');
    } catch (err) {
      expect(err).toBeInstanceOf(ContactValidationError);
      expect((err as ContactValidationError).channel).toBe('sms');
      expect((err as Error).message).toContain('E.164');
      expect((err as Error).message).not.toContain('5551234');
    }
  });
});

describe('in-app tetik değerlendirme', () => {
  const t = (op: 'eq' | 'neq' | 'exists' | 'gt' | 'lt', value?: string | number) =>
    ({ kind: 'trigger', key: 'level', op, value }) as Extract<InAppTrigger, { kind: 'trigger' }>;

  it('eq / neq: sayısal değerler sayı, diğerleri metin olarak karşılaştırılır', () => {
    expect(matchesTriggerCondition(t('eq', 5), { level: 5 })).toBe(true);
    expect(matchesTriggerCondition(t('eq', '5'), { level: 5 })).toBe(true);
    expect(matchesTriggerCondition(t('eq', '5.0'), { level: '5' })).toBe(true);
    expect(matchesTriggerCondition(t('eq', 'gold'), { level: 'gold' })).toBe(true);
    expect(matchesTriggerCondition(t('eq', 'gold'), { level: 'Gold' })).toBe(false);
    expect(matchesTriggerCondition(t('eq', 'true'), { level: true })).toBe(true);
    expect(matchesTriggerCondition(t('eq', 5), {})).toBe(false);
    expect(matchesTriggerCondition(t('neq', 5), { level: 6 })).toBe(true);
    expect(matchesTriggerCondition(t('neq', 5), { level: '5' })).toBe(false);
    // Tanımsız anahtar "eşit değil" sayılır.
    expect(matchesTriggerCondition(t('neq', 5), {})).toBe(true);
  });

  it('exists / gt / lt', () => {
    expect(matchesTriggerCondition(t('exists'), { level: 0 })).toBe(true);
    expect(matchesTriggerCondition(t('exists'), { other: 1 })).toBe(false);
    expect(matchesTriggerCondition(t('gt', 3), { level: 4 })).toBe(true);
    expect(matchesTriggerCondition(t('gt', 3), { level: '3' })).toBe(false);
    expect(matchesTriggerCondition(t('gt', '2.5'), { level: '10' })).toBe(true);
    expect(matchesTriggerCondition(t('lt', 3), { level: 2 })).toBe(true);
    expect(matchesTriggerCondition(t('lt', 3), { level: 3 })).toBe(false);
    // Sayıya çevrilemeyen değer karşılaştırılmaz.
    expect(matchesTriggerCondition(t('gt', 3), { level: 'çok' })).toBe(false);
    expect(matchesTriggerCondition(t('lt', 3), {})).toBe(false);
  });

  it('session_start, event ve screen koşulları', () => {
    expect(triggersMatch([{ kind: 'session_start' }], ctx({ sessionStart: true }))).toBe(true);
    expect(triggersMatch([{ kind: 'session_start' }], ctx())).toBe(false);
    const event: InAppTrigger[] = [{ kind: 'event', name: 'cart_viewed' }];
    expect(triggersMatch(event, ctx({ eventName: 'cart_viewed' }))).toBe(true);
    expect(triggersMatch(event, ctx({ eventName: 'purchase' }))).toBe(false);
    expect(triggersMatch(event, ctx())).toBe(false);
    const screen: InAppTrigger[] = [{ kind: 'screen', name: 'checkout' }];
    expect(triggersMatch(screen, ctx({ screen: 'checkout' }))).toBe(true);
    expect(triggersMatch(screen, ctx({ screen: 'home' }))).toBe(false);
    // Koşulsuz mesaj her değerlendirmede uygundur.
    expect(triggersMatch([], ctx())).toBe(true);
  });

  it('tüm koşullar aynı anda sağlanmalı', () => {
    const triggers: InAppTrigger[] = [
      { kind: 'event', name: 'cart_viewed' },
      { kind: 'screen', name: 'cart' },
      { kind: 'trigger', key: 'vip', op: 'eq', value: 'yes' },
    ];
    const ok = ctx({ eventName: 'cart_viewed', screen: 'cart', triggers: { vip: 'yes' } });
    expect(triggersMatch(triggers, ok)).toBe(true);
    expect(triggersMatch(triggers, { ...ok, screen: 'home' })).toBe(false);
    expect(triggersMatch(triggers, { ...ok, triggers: { vip: 'no' } })).toBe(false);
    expect(triggersMatch(triggers, { ...ok, eventName: undefined })).toBe(false);
  });
});

describe('in-app sıklık ve öncelik', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');

  it('kalan gösterim hakkından yerel bekleyen gösterimler düşülür', () => {
    expect(frequencyAllows(message({ remaining_impressions: 1 }), undefined, now)).toBe(true);
    expect(frequencyAllows(message({ remaining_impressions: 0 }), undefined, now)).toBe(false);
    expect(
      frequencyAllows(message({ remaining_impressions: 1 }), { lastAt: now, pending: 1 }, now),
    ).toBe(false);
    expect(
      frequencyAllows(message({ remaining_impressions: 3 }), { lastAt: now, pending: 1 }, now),
    ).toBe(true);
  });

  it('min_interval_seconds sunucu ve yerel son gösterimin en yenisine göre uygulanır', () => {
    const m = message({
      remaining_impressions: 5,
      min_interval_seconds: 3600,
      last_impression_at: new Date(now - 2 * 3600_000).toISOString(),
    });
    expect(frequencyAllows(m, undefined, now)).toBe(true);
    expect(frequencyAllows(m, { lastAt: now - 60_000, pending: 0 }, now)).toBe(false);
    expect(frequencyAllows(m, { lastAt: now - 3601_000, pending: 0 }, now)).toBe(true);
    const recent = { ...m, last_impression_at: new Date(now - 10_000).toISOString() };
    expect(frequencyAllows(recent, undefined, now)).toBe(false);
  });

  it('stop_after_interaction: yerel etkileşimden sonra hak kalsa da gösterilmez', () => {
    const local = { lastAt: now - 60_000, pending: 0, interacted: true };
    const stop = message({ remaining_impressions: 5, stop_after_interaction: true });
    expect(frequencyAllows(stop, undefined, now)).toBe(true);
    expect(frequencyAllows(stop, { ...local, interacted: false }, now)).toBe(true);
    expect(frequencyAllows(stop, local, now)).toBe(false);
    // Bayrak kapalıysa etkileşim gösterimi engellemez.
    expect(frequencyAllows({ ...stop, stop_after_interaction: false }, local, now)).toBe(true);
  });

  it('bitiş zamanı geçmiş mesaj gösterilmez', () => {
    expect(
      frequencyAllows(message({ end_at: new Date(now - 1).toISOString() }), undefined, now),
    ).toBe(false);
    expect(
      frequencyAllows(message({ end_at: new Date(now + 60_000).toISOString() }), undefined, now),
    ).toBe(true);
  });

  it('birden fazla uygun mesajda önceliği yüksek olan seçilir; eşitlikte liste sırası', () => {
    const list = [
      message({ id: 'low', priority: 1 }),
      message({ id: 'high', priority: 10 }),
      message({ id: 'high2', priority: 10 }),
      message({ id: 'top-but-used', priority: 99, remaining_impressions: 0 }),
      message({ id: 'top-other-event', priority: 50, triggers: [{ kind: 'event', name: 'x' }] }),
    ];
    expect(pickMessage(list, ctx(), {}, now)?.id).toBe('high');
    expect(pickMessage(list, ctx({ eventName: 'x' }), {}, now)?.id).toBe('top-other-event');
    expect(pickMessage([], ctx(), {}, now)).toBeNull();
  });
});

describe('in-app güvenli değerler', () => {
  it('URL, deeplink ve renk doğrulaması', () => {
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeDeeplink('myapp://cart')).toBe('myapp://cart');
    expect(safeDeeplink('https://example.com')).toBe('https://example.com');
    expect(safeDeeplink('javascript://%0aalert(1)')).toBeNull();
    expect(safeDeeplink('data://text/html,x')).toBeNull();
    expect(safeDeeplink('cart')).toBeNull();
    expect(safeColor('#fff')).toBe('#fff');
    expect(safeColor('#18181B')).toBe('#18181B');
    expect(safeColor('#18181b80')).toBe('#18181b80');
    expect(safeColor('red;background:url(x)')).toBeNull();
    expect(safeColor(null)).toBeNull();
  });
});
