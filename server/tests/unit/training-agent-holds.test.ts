/**
 * Experimental 3.3 holds (#8181): the draft-derivation rules, the fixtures,
 * the served-version gate, and the installment flight hook. The end-to-end
 * behavior is graded in training-agent-hold-vectors.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildCatalog, buildProposals } from '../../src/training-agent/product-factory.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import { installmentFlightEnd, plannedHoldExpiry, runWithHoldPlan } from '../../src/training-agent/holds/context.js';
import { HOLD_FIXTURES, holdFixture, runWithSeededHoldFixtures, seededHoldFixture } from '../../src/training-agent/holds/fixtures.js';
import { AGENT_DEFAULT_POLICY, deriveDraftPolicy, durationMs, durationsOrdered } from '../../src/training-agent/holds/policy.js';
import { holdsServed, supportsHolds33 } from '../../src/training-agent/holds/service.js';

const DAY = 24 * 60 * 60 * 1000;

describe('hold-policy durations', () => {
  it('measures elapsed time, a day being exactly 24 hours', () => {
    expect(durationMs('P1D')).toBe(DAY);
    expect(durationMs('PT24H')).toBe(DAY);
    expect(durationMs('P1DT12H')).toBe(durationMs('PT36H'));
    expect(durationMs('PT90M')).toBe(90 * 60 * 1000);
    expect(() => durationMs('P1W')).toThrow();
    expect(() => durationMs('P')).toThrow();
    expect(() => durationMs('PT')).toThrow();
  });
});

describe('draft policy derivation', () => {
  const exclusive = { available: true, min_duration: 'P1D', max_duration: 'P3D' };
  const creator = { available: true, min_duration: 'P2D', max_duration: 'P5D', extendable: true, max_total_duration: 'P21D', rankable: true };

  it('is non-holdable when any allocated product is', () => {
    expect(deriveDraftPolicy([exclusive, { available: false }])).toEqual({ available: false });
  });

  it('takes the agent default (inventory_hold) for products without a policy', () => {
    expect(deriveDraftPolicy([])).toEqual({ available: true });
    expect(deriveDraftPolicy([AGENT_DEFAULT_POLICY])).toEqual({ available: true });
  });

  it('never promises more than any allocated product', () => {
    const derived = deriveDraftPolicy([exclusive, creator]);
    // max_duration is the smallest declared; min_duration is capped at it.
    expect(derived).toEqual({ available: true, min_duration: 'P2D', max_duration: 'P3D', rankable: true });
    expect(durationMs(derived.min_duration!)).toBeLessThanOrEqual(durationMs(derived.max_duration!));
  });

  it('is extendable only if every product is, with the smallest total ceiling', () => {
    const shortTotal = { ...creator, max_total_duration: 'P10D' };
    expect(deriveDraftPolicy([creator, shortTotal])).toMatchObject({ extendable: true, max_total_duration: 'P10D' });
    expect(deriveDraftPolicy([creator, AGENT_DEFAULT_POLICY])).not.toHaveProperty('extendable');
    expect(deriveDraftPolicy([creator, AGENT_DEFAULT_POLICY])).not.toHaveProperty('max_total_duration');
  });

  it('is rankable if any product is', () => {
    expect(deriveDraftPolicy([AGENT_DEFAULT_POLICY, creator]).rankable).toBe(true);
    expect(deriveDraftPolicy([exclusive])).not.toHaveProperty('rankable');
  });

  it('keeps max_duration within max_total_duration', () => {
    const derived = deriveDraftPolicy([{ available: true, max_duration: 'P5D', extendable: true, max_total_duration: 'P3D' }]);
    expect(derived).toMatchObject({ max_duration: 'P3D', max_total_duration: 'P3D' });
    expect(durationsOrdered(derived)).toBe(true);
  });
});

describe('hold-policy fixtures', () => {
  const catalog = new Map(buildCatalog().map(entry => [entry.product.product_id, entry.product as unknown as Record<string, unknown>]));

  it('name catalog products with schema-valid, ordered policies', () => {
    for (const [productId, fixture] of Object.entries(HOLD_FIXTURES)) {
      expect(catalog.has(productId), productId).toBe(true);
      const result = validateSourceSchema('core/hold-policy.json', fixture.policy);
      expect(result.valid, `${productId}: ${JSON.stringify(result.errors)}`).toBe(true);
      expect(durationsOrdered(fixture.policy), productId).toBe(true);
    }
  });

  it('cover an exclusive, a ranked, a non-holdable, an extendable, and an installment product', () => {
    const fixtures = Object.values(HOLD_FIXTURES);
    expect(fixtures.some(f => f.policy.available && !f.policy.rankable && !f.policy.extendable)).toBe(true);
    expect(fixtures.some(f => f.policy.rankable === true && f.contention === 'product')).toBe(true);
    expect(fixtures.some(f => !f.policy.available)).toBe(true);
    expect(fixtures.some(f => f.policy.extendable === true && f.policy.max_total_duration && f.contention === 'product')).toBe(true);
    const installment = Object.entries(HOLD_FIXTURES).filter(([, f]) => f.contention === 'installment');
    expect(installment.length).toBeGreaterThan(0);
    for (const [productId] of installment) {
      const installments = catalog.get(productId)!.installments as Array<Record<string, any>>;
      expect(installments.length, productId).toBeGreaterThan(0);
      expect(installments.every(entry => typeof entry.deadlines?.booking_deadline === 'string'), productId).toBe(true);
    }
  });

  it('keep contention off the demonstration proposals storyboards finalize', () => {
    // Only the creator plan allocates fixture products, so repeated
    // storyboard runs over the other registry proposals never contend.
    for (const proposal of buildProposals(buildCatalog())) {
      if (proposal.proposal_id === 'creatorloop_everyday_lifestyle') continue;
      const fixtured = proposal.allocations.map(allocation => allocation.product_id).filter(id => id in HOLD_FIXTURES);
      expect(fixtured, proposal.proposal_id).toEqual([]);
    }
  });
});

describe('served-version gate', () => {
  it('serves holds at the 3.3 preview and candidate, never below 3.3', () => {
    expect(supportsHolds33('3.3-beta.3')).toBe(true);
    expect(supportsHolds33('3.3')).toBe(true);
    for (const version of ['3.2', '3.2-rc.7', '3.1', '3.0', undefined]) expect(supportsHolds33(version)).toBe(false);
  });

  it('serves holds only on routes whose refinement this module runs', () => {
    expect(holdsServed({ servedAdcpVersion: '3.3-beta.3' })).toBe(true);
    expect(holdsServed({ servedAdcpVersion: '3.3-beta.3', proposalNegotiationProfile: 'ask-only' })).toBe(true);
    expect(holdsServed({ servedAdcpVersion: '3.3-beta.3', proposalNegotiationProfile: 'typed-negotiation' })).toBe(false);
    expect(holdsServed({ servedAdcpVersion: '3.2' })).toBe(false);
  });
});

describe('hold plan hooks', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const defaultEnd = now + 31 * DAY;
  const slot = (days: number, status = 'scheduled') => ({
    scheduled_at: new Date(now + days * DAY).toISOString(), duration_seconds: 600, status,
  });

  it('leaves the engine alone outside a plan', async () => {
    expect(installmentFlightEnd([{ installments: [slot(60)] }], defaultEnd, now)).toBeUndefined();
    expect(plannedHoldExpiry('proposal_x')).toBeUndefined();
  });

  it('stretches a draft flight over the upcoming installments it buys', async () => {
    await runWithHoldPlan({ installmentFlights: true }, async () => {
      expect(installmentFlightEnd([{ installments: [slot(60), slot(74)] }], defaultEnd, now)).toBe(now + 74 * DAY + 600_000);
      // Past, aired, and cancelled installments do not move the flight.
      expect(installmentFlightEnd([{ installments: [slot(-5), slot(40, 'aired'), slot(45, 'cancelled')] }], defaultEnd, now)).toBe(defaultEnd);
      expect(installmentFlightEnd([undefined, {}], defaultEnd, now)).toBe(defaultEnd);
    });
  });

  it('hands the finalize engine the deadline the plan placed', async () => {
    const expiresAt = new Date(now + 3 * DAY).toISOString();
    await runWithHoldPlan({ expiresAtBySource: new Map([['proposal_x', expiresAt]]) }, async () => {
      expect(plannedHoldExpiry('proposal_x')).toBe(expiresAt);
      expect(plannedHoldExpiry('proposal_y')).toBeUndefined();
    });
  });
});

describe('seeded hold policies', () => {
  it('accepts a seeded product hold_policy the schema allows, contending per product', () => {
    expect(seededHoldFixture({ hold_policy: { available: false } })).toEqual({ policy: { available: false }, contention: 'product' });
    expect(seededHoldFixture({
      hold_policy: { available: true, min_duration: 'P1D', max_duration: 'P3D', extendable: true, max_total_duration: 'P10D', rankable: true },
    })).toEqual({
      policy: { available: true, min_duration: 'P1D', max_duration: 'P3D', extendable: true, max_total_duration: 'P10D', rankable: true },
      contention: 'product',
    });
  });

  it('ignores a missing or invalid seeded hold_policy', () => {
    expect(seededHoldFixture({})).toBeUndefined();
    expect(seededHoldFixture({ hold_policy: { min_duration: 'P1D' } })).toBeUndefined();
    expect(seededHoldFixture({ hold_policy: { available: false, rankable: true } })).toBeUndefined();
    expect(seededHoldFixture({ hold_policy: { available: true, min_duration: 'P3D', max_duration: 'P1D' } })).toBeUndefined();
    expect(seededHoldFixture({ hold_policy: { available: true, max_duration: 'P1W' } })).toBeUndefined();
    expect(seededHoldFixture({ hold_policy: { available: true, max_total_duration: 'P10D' } })).toBeUndefined();
    expect(seededHoldFixture({ hold_policy: { available: true, extendable: 'yes' } })).toBeUndefined();
  });

  it('resolves seeded policies ahead of the catalog, only inside the request scope', async () => {
    const seeded = new Map([['crestline_radio_premium', { policy: { available: false }, contention: 'product' as const }]]);
    const inside = await runWithSeededHoldFixtures(seeded, async () => holdFixture('crestline_radio_premium'));
    expect(inside?.policy).toEqual({ available: false });
    expect(holdFixture('crestline_radio_premium')?.policy).toEqual(HOLD_FIXTURES.crestline_radio_premium!.policy);
  });
});
