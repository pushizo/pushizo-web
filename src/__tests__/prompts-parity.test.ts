// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMLINK_SELECTOR, renderCustomLink } from '../browser/customlink.js';
import {
  canShowPrompt,
  promptBackoffMs,
  PROMPT_BACKOFF_DAYS,
  recordPromptDismissal,
  texts,
} from '../browser/prompts.js';
import { DEFAULT_STATE } from '../core/storage.js';
import { DEFAULT_CLICK_BEHAVIOR, matchClient, parseClickBehavior } from '../sw/payload.js';

const DAY = 86_400_000;

describe('istem geri çekilmesi (3/7/30 gün)', () => {
  it('ret sayısına göre bekleme süresi', () => {
    expect(PROMPT_BACKOFF_DAYS).toEqual([3, 7, 30]);
    expect(promptBackoffMs(0)).toBe(0);
    expect(promptBackoffMs(1)).toBe(3 * DAY);
    expect(promptBackoffMs(2)).toBe(7 * DAY);
    expect(promptBackoffMs(3)).toBe(30 * DAY);
    expect(promptBackoffMs(12)).toBe(30 * DAY);
    // Eski sabit `retryDays` seçeneği korunur.
    expect(promptBackoffMs(5, 1)).toBe(DAY);
  });

  it('ardışık retlerde süre uzar; izin istemi süre dolunca tekrar gösterilir', () => {
    const now = 1_700_000_000_000;
    let state = { promptDismissCount: DEFAULT_STATE.promptDismissCount, slidedownDismissedAt: DEFAULT_STATE.slidedownDismissedAt };
    expect(canShowPrompt(state, now)).toBe(true);

    state = recordPromptDismissal(state, now);
    expect(state.promptDismissCount).toBe(1);
    expect(canShowPrompt(state, now + 3 * DAY - 1)).toBe(false);
    expect(canShowPrompt(state, now + 3 * DAY)).toBe(true);

    state = recordPromptDismissal(state, now + 3 * DAY);
    expect(canShowPrompt(state, now + 3 * DAY + 7 * DAY - 1)).toBe(false);
    expect(canShowPrompt(state, now + 10 * DAY)).toBe(true);

    state = recordPromptDismissal(state, now + 10 * DAY);
    expect(state.promptDismissCount).toBe(3);
    expect(canShowPrompt(state, now + 39 * DAY)).toBe(false);
    expect(canShowPrompt(state, now + 40 * DAY)).toBe(true);
  });

  it('sayaçsız eski kayıt bir ret sayılır', () => {
    const now = 1_700_000_000_000;
    expect(canShowPrompt({ promptDismissCount: 0, slidedownDismissedAt: now }, now + 2 * DAY)).toBe(false);
    expect(canShowPrompt({ promptDismissCount: 0, slidedownDismissedAt: now }, now + 3 * DAY)).toBe(true);
  });
});

describe('karşılama bildirimi metni', () => {
  it('varsayılan metin dile göre seçilir', () => {
    expect(texts('en-US').welcome).toBe('Thanks for subscribing!');
    expect(texts('tr-TR').welcome).toBe('Abone olduğunuz için teşekkürler!');
    expect(DEFAULT_STATE.welcomeNotificationShown).toBe(false);
  });
});

describe('bildirim tıklama davranışı', () => {
  const clients = [{ url: 'https://shop.example/cart' }, { url: 'https://shop.example/' }, { url: 'https://other.example/a' }];

  it('geçersiz ayar varsayılana düşer', () => {
    expect(parseClickBehavior(null)).toEqual(DEFAULT_CLICK_BEHAVIOR);
    expect(parseClickBehavior({ match: 'x', action: 1 })).toEqual({ match: 'exact', action: 'navigate' });
    expect(parseClickBehavior({ match: 'origin', action: 'focus' })).toEqual({ match: 'origin', action: 'focus' });
  });

  it('exact tam URL, origin aynı origin ile eşleşir', () => {
    expect(matchClient(clients, 'https://shop.example/', 'exact')).toBe(clients[1]);
    expect(matchClient(clients, 'https://shop.example/orders', 'exact')).toBeUndefined();
    expect(matchClient(clients, 'https://shop.example/orders', 'origin')).toBe(clients[0]);
    expect(matchClient(clients, 'https://new.example/', 'origin')).toBeUndefined();
    expect(matchClient(clients, 'geçersiz', 'origin')).toBeUndefined();
  });
});

describe('özel bağlantı istemi (custom link)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function container(): Element {
    document.body.innerHTML = '<div class="herosignal-customlink-container"></div>';
    return document.querySelector(CUSTOMLINK_SELECTOR)!;
  }

  it('düğmeyi erişilebilir biçimde render eder ve durum değişince günceller', () => {
    const el = container();
    const onClick = vi.fn();
    const opts = { enabled: true, size: 'large' as const, color: { button: '#ff0000', text: '#ffffff' } };
    renderCustomLink(el, opts, 'en', { subscribed: false, busy: false }, onClick);
    const button = el.querySelector('button')!;
    expect(button.type).toBe('button');
    expect(button.textContent).toBe('Subscribe to push notifications');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.className).toContain('hs-large');
    expect(button.style.background).not.toBe('');
    expect(button.style.color).not.toBe('');
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    renderCustomLink(el, opts, 'en', { subscribed: true, busy: true }, onClick);
    // Yeniden render tek düğmeyi günceller, çoğaltmaz.
    expect(el.querySelectorAll('button')).toHaveLength(1);
    expect(button.textContent).toBe('Unsubscribe from push notifications');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('metinler HTML olarak yorumlanmaz, geçersiz renk yok sayılır', () => {
    const el = container();
    renderCustomLink(
      el,
      { enabled: true, style: 'link', color: { button: 'red;background:url(x)' }, text: { subscribe: '<img src=x onerror=alert(1)>', explanation: '<b>açıklama</b>' } },
      'tr',
      { subscribed: false, busy: false },
      () => undefined,
    );
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('button')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el.querySelector('.hs-customlink-explanation')!.textContent).toBe('<b>açıklama</b>');
    expect(el.querySelector<HTMLButtonElement>('button')!.style.color).toBe('');
    expect(el.querySelector('button')!.className).toContain('hs-link');
  });

  it('abonelikten çıkma kapalıysa abone iken düğme gizlenir', () => {
    const el = container();
    renderCustomLink(el, { enabled: true, unsubscribeEnabled: false }, 'tr', { subscribed: true, busy: false }, () => undefined);
    expect(el.querySelector('button')!.hidden).toBe(true);
    renderCustomLink(el, { enabled: true, unsubscribeEnabled: false }, 'tr', { subscribed: false, busy: false }, () => undefined);
    expect(el.querySelector('button')!.hidden).toBe(false);
    expect(el.querySelector('button')!.textContent).toBe('Bildirimlere abone ol');
  });
});
