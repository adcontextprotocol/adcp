import { afterEach, describe, expect, it, vi } from 'vitest';

import { Cache } from '../../src/cache.js';

describe('Cache capacity', () => {
  afterEach(() => vi.useRealTimers());

  it('evicts the least recently used entry at the configured cap', () => {
    const cache = new Cache<number>(60, 2);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.size()).toBe(2);
  });

  it('prunes expired entries before applying the cap', () => {
    vi.useFakeTimers();
    const cache = new Cache<number>(1, 1);
    cache.set('expired', 1);
    vi.advanceTimersByTime(60_001);

    cache.set('fresh', 2);

    expect(cache.get('expired')).toBeUndefined();
    expect(cache.get('fresh')).toBe(2);
    expect(cache.size()).toBe(1);
  });
});
