import { afterEach, describe, expect, it, vi } from 'vitest';
import { newEventId } from '../core/event-id.js';

describe('newEventId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('randomUUID varsa UUID üretir ve her çağrıda farklıdır', () => {
    const a = newEventId();
    const b = newEventId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('randomUUID yoksa getRandomValues ile 32 hane onaltılık kimlik üretir (sunucu biçimi: 8–64, [A-Za-z0-9._:-])', () => {
    vi.stubGlobal('crypto', { getRandomValues: (arr: Uint8Array) => arr.fill(171) });
    expect(newEventId()).toBe('ab'.repeat(16));
  });
});
