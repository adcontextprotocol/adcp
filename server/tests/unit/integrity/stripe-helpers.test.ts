/**
 * Tests for the Stripe-customer fetch cache used by the integrity invariants.
 * Three invariants in Phase 1 hit `customers.retrieve` for the same set of
 * orgs; this cache dedupes those calls within one /check run.
 */
import { describe, it, expect, vi } from 'vitest';
import { getStripeCustomerCached, isStripeNotFound } from '../../../src/audit/integrity/stripe-helpers.js';
import type { InvariantContext } from '../../../src/audit/integrity/types.js';

function makeCtx(retrieve: (id: string) => Promise<unknown>, cache?: Map<string, unknown>): InvariantContext {
  return {
    pool: {} as InvariantContext['pool'],
    workos: {} as InvariantContext['workos'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as InvariantContext['logger'],
    stripe: {
      customers: { retrieve },
    } as unknown as InvariantContext['stripe'],
    stripeCustomerCache: cache as InvariantContext['stripeCustomerCache'],
  };
}

describe('getStripeCustomerCached', () => {
  it('hits Stripe API on first call, caches result for subsequent calls', async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: 'cus_1', metadata: {} });
    const cache = new Map();
    const ctx = makeCtx(retrieve, cache);

    const a = await getStripeCustomerCached(ctx, 'cus_1');
    const b = await getStripeCustomerCached(ctx, 'cus_1');

    expect(retrieve).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it('caches different ids independently', async () => {
    const retrieve = vi.fn(async (id: string) => ({ id, metadata: {} }));
    const ctx = makeCtx(retrieve, new Map());

    const a = await getStripeCustomerCached(ctx, 'cus_1');
    const b = await getStripeCustomerCached(ctx, 'cus_2');

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it('falls back to direct calls when no cache is provided in context', async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: 'cus_1', metadata: {} });
    const ctx = makeCtx(retrieve); // no cache

    await getStripeCustomerCached(ctx, 'cus_1');
    await getStripeCustomerCached(ctx, 'cus_1');

    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures — next call retries', async () => {
    const retrieve = vi.fn()
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce({ id: 'cus_1', metadata: {} });
    const cache = new Map();
    const ctx = makeCtx(retrieve, cache);

    await expect(getStripeCustomerCached(ctx, 'cus_1')).rejects.toThrow('rate limit');
    expect(cache.size).toBe(0);

    const result = await getStripeCustomerCached(ctx, 'cus_1');
    expect((result as { id: string }).id).toBe('cus_1');
    expect(cache.size).toBe(1);
  });
});

describe('isStripeNotFound', () => {
  it('returns true for code=resource_missing', () => {
    expect(isStripeNotFound({ code: 'resource_missing' })).toBe(true);
  });

  it('returns true for statusCode=404', () => {
    expect(isStripeNotFound({ statusCode: 404 })).toBe(true);
  });

  it('returns false for other shapes', () => {
    expect(isStripeNotFound({ code: 'rate_limit', statusCode: 429 })).toBe(false);
    expect(isStripeNotFound(new Error('something'))).toBe(false);
    expect(isStripeNotFound(null)).toBe(false);
    expect(isStripeNotFound(undefined)).toBe(false);
    expect(isStripeNotFound('string')).toBe(false);
  });
});
