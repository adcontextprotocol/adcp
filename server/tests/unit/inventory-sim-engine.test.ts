/**
 * #9025 part B: the deterministic inventory delivery engine behind the
 * training agent's inventory tenants. Allocation primitives, traffic
 * generation, the day steps, forecasts, installments and reporting delay.
 */
import { describe, expect, it } from 'vitest';
import {
  ADSERVER_SEASON,
  CONTENT_SEASON,
  EngineError,
  InventorySimulation,
  SeasonTraffic,
  allocateAuction,
  allocateHighWaterMark,
  audienceCurve,
  takeEqualShare,
  takeShareOfVoice,
  toAdcpForecast,
  type CellCounts,
  type SeasonSeed,
} from '../../src/training-agent/inventory-sim/engine/index.js';

const at = (iso: string) => Date.parse(iso);
const counts = (entries: Array<[number, number]>): CellCounts => new Map(entries);
const total = (taken: CellCounts | undefined) => [...(taken ?? new Map()).values()].reduce((sum, value) => sum + value, 0);

function expectEngineError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineError);
  expect((caught as EngineError).code).toBe(code);
}

/** One placement, one region, one profile: 10,000 impressions a day, with a
 * five-day outage that cuts traffic to 20%. */
function scarceSeed(overrides: Partial<SeasonSeed> = {}): SeasonSeed {
  return {
    seed_id: 'scarce-test',
    rng_seed: 'scarce-test-v1',
    start_date: '2027-01-01',
    days: 60,
    currency: 'USD',
    regions: [{ region_id: 'r1', country: 'US', name: 'Region one', share: 1 }],
    audience_profiles: [
      { profile_id: 'p1', name: 'Profile one', share: 0.6 },
      { profile_id: 'p2', name: 'Profile two', share: 0.4 },
    ],
    segments: [
      { segment_id: 's1', name: 'Segment one', profile_ids: ['p1'] },
      { segment_id: 's12', name: 'Segment one and two', profile_ids: ['p1', 'p2'] },
    ],
    properties: [{ property_id: 'site', name: 'Site', domain: 'site.example' }],
    placements: [{
      placement_id: 'banner',
      name: 'Banner',
      channel: 'display',
      property_ids: ['site'],
      formats: ['display_300x250'],
      base_daily_impressions: 10_000,
      floor_cpm: 2,
      rates: { viewability: 0.7, click_rate: 0.001, completion_rate: 0, conversion_rate: 0.02 },
      reporting_lag_days: 0,
    }],
    products: [
      { product_id: 'banner_guaranteed', name: 'Banner', description: 'Guaranteed banner', delivery_type: 'guaranteed', placement_ids: ['banner'], rate_cpm: 10 },
      { product_id: 'banner_auction', name: 'Banner auction', description: 'Auction banner', delivery_type: 'non_guaranteed', placement_ids: ['banner'] },
    ],
    traffic: { weekday_shape: [1, 1, 1, 1, 1, 1, 1] },
    forecast_error: { day_sigma: 0, cell_sigma: 0 },
    events: [{
      type: 'traffic_multiplier',
      event_id: 'outage',
      description: 'Outage',
      start_date: '2027-01-06',
      end_date: '2027-01-10',
      multiplier: 0.2,
    }],
    ...overrides,
  };
}

describe('allocation primitives', () => {
  it('serves the most constrained booking first: B takes the first cell, A the second', () => {
    const remaining = counts([[1, 100], [2, 100]]);
    const result = allocateHighWaterMark(remaining, [
      { id: 'A', cells: [1, 2], target: 100 },
      { id: 'B', cells: [1], target: 100 },
    ]);
    expect(Object.fromEntries(result.get('B')!)).toEqual({ 1: 100 });
    expect(Object.fromEntries(result.get('A')!)).toEqual({ 2: 100 });
    expect(total(result.get('A'))).toBe(100);
    expect(total(result.get('B'))).toBe(100);
  });

  it('takes the same share of every usable cell and never more than the target', () => {
    const remaining = counts([[1, 300], [2, 100], [3, 600]]);
    const taken = takeEqualShare(remaining, [1, 2, 3], 500);
    expect(total(taken)).toBe(500);
    expect(Object.fromEntries(taken)).toEqual({ 1: 150, 2: 50, 3: 300 });
    expect(Object.fromEntries(remaining)).toEqual({ 1: 150, 2: 50, 3: 300 });
  });

  it('hands rounding leftovers to the largest remainders and keeps totals exact', () => {
    const remaining = counts([[1, 7], [2, 7], [3, 7]]);
    const taken = takeEqualShare(remaining, [1, 2, 3], 10);
    expect(total(taken)).toBe(10);
    for (const value of remaining.values()) expect(value).toBeGreaterThanOrEqual(0);
    expect([...taken.values()].sort()).toEqual([3, 3, 4]);
  });

  it('gives everything left when the cells cannot cover the target', () => {
    const remaining = counts([[1, 40], [2, 30]]);
    const result = allocateHighWaterMark(remaining, [{ id: 'A', cells: [1, 2], target: 100 }]);
    expect(total(result.get('A'))).toBe(70);
    expect(total(remaining)).toBe(0);
  });

  it('breaks supply ties by booking id', () => {
    const remaining = counts([[1, 100]]);
    const result = allocateHighWaterMark(remaining, [
      { id: 'b', cells: [1], target: 80 },
      { id: 'a', cells: [1], target: 80 },
    ]);
    expect(total(result.get('a'))).toBe(80);
    expect(total(result.get('b'))).toBe(20);
  });

  it('serves the highest bid first, respects floors and stops at the daily budget', () => {
    const remaining = counts([[1, 1000], [2, 1000]]);
    const floors: Record<number, number> = { 1: 1, 2: 5 };
    const result = allocateAuction(remaining, [
      { id: 'low', cells: [1, 2], bid_cpm: 2, daily_budget: 100 },
      { id: 'high', cells: [1, 2], bid_cpm: 6, daily_budget: 6 },
    ], cell => floors[cell]);
    // high: $6 at $6 CPM buys 1,000, spread over both cells.
    expect(total(result.get('high'))).toBe(1000);
    // low: below the floor of cell 2, so only what high left of cell 1.
    expect([...result.get('low')!.keys()]).toEqual([1]);
    expect(total(result.get('low'))).toBe(500);
  });

  it('takes a share of each cell for share-of-voice', () => {
    const actual = counts([[1, 100], [2, 51]]);
    const remaining = new Map(actual);
    expect(Object.fromEntries(takeShareOfVoice(remaining, actual, [1, 2], 0.5))).toEqual({ 1: 50, 2: 25 });
    expect(Object.fromEntries(takeShareOfVoice(remaining, actual, [1, 2], 0.5))).toEqual({ 1: 50, 2: 25 });
    expect(Object.fromEntries(remaining)).toEqual({ 2: 1, 1: 0 });
  });
});

describe('traffic', () => {
  it('generates the same tables from the same seed, and different ones from another rng_seed', () => {
    const a = new SeasonTraffic(scarceSeed({ forecast_error: { day_sigma: 0.1, cell_sigma: 0.1 } }));
    const b = new SeasonTraffic(scarceSeed({ forecast_error: { day_sigma: 0.1, cell_sigma: 0.1 } }));
    const c = new SeasonTraffic(scarceSeed({ rng_seed: 'other', forecast_error: { day_sigma: 0.1, cell_sigma: 0.1 } }));
    for (let day = 0; day < 60; day++) {
      expect([...a.day(day).actual]).toEqual([...b.day(day).actual]);
      expect(a.rates(day, 0)).toEqual(b.rates(day, 0));
    }
    expect([...a.day(3).actual]).not.toEqual([...c.day(3).actual]);
  });

  it('keeps forecast and actual apart by noise and events', () => {
    const traffic = new SeasonTraffic(ADSERVER_SEASON);
    let forecast = 0;
    let actual = 0;
    let differing = 0;
    for (let day = 60; day < 90; day++) {
      const tables = traffic.day(day);
      for (const [cell, value] of tables.forecast) {
        forecast += value;
        actual += tables.actual.get(cell) ?? 0;
        if ((tables.actual.get(cell) ?? 0) !== value) differing += 1;
      }
    }
    expect(actual).not.toBe(forecast);
    expect(differing).toBeGreaterThan(100);
    expect(Math.abs(actual / forecast - 1)).toBeLessThan(0.15);
  });

  it('counts a profile once when two targeted segments overlap', () => {
    const traffic = new SeasonTraffic(scarceSeed());
    const both = traffic.eligibleCells('banner_guaranteed', { segment_ids: ['s1', 's12'] });
    expect(both).toEqual(traffic.eligibleCells('banner_guaranteed', { segment_ids: ['s12'] }));
    expect(new Set(both).size).toBe(both.length);
    expect(traffic.eligibleCells('banner_guaranteed', { segment_ids: ['s1'] })).toHaveLength(1);
  });

  it('builds installment audience over the channel curve', () => {
    expect(audienceCurve('newsletter')).toHaveLength(3);
    expect(audienceCurve('podcast')).toHaveLength(30);
    expect(audienceCurve('creator_video').length).toBeGreaterThanOrEqual(28);
    for (const channel of ['newsletter', 'podcast', 'creator_video'] as const) {
      expect(audienceCurve(channel).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    }
  });

  it('refuses an inconsistent seed', () => {
    expect(() => new SeasonTraffic(scarceSeed({ regions: [{ region_id: 'r1', country: 'US', name: 'R', share: 0.5 }] })))
      .toThrow(EngineError);
    expect(() => new SeasonTraffic(scarceSeed({
      products: [{ product_id: 'x', name: 'x', description: 'x', delivery_type: 'guaranteed', placement_ids: ['missing'], rate_cpm: 1 }],
    }))).toThrow(/unknown placement/);
  });
});

describe('simulation', () => {
  const now = at('2026-12-31T12:00:00Z');
  const flight = { flight_start_ms: at('2027-01-01T00:00:00Z'), flight_end_ms: at('2027-01-31T00:00:00Z') };

  it('serves a booking from the day after it is confirmed', () => {
    const sim = InventorySimulation.create(scarceSeed(), at('2027-01-03T09:00:00Z'));
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 50_000 }, at('2027-01-03T09:00:00Z'));
    sim.advanceTo(at('2027-01-06T00:00:00Z'));
    expect(sim.booking('g').days.map(day => day.date)).toEqual(['2027-01-04', '2027-01-05']);
  });

  it('under-delivers a guarantee through an outage, then catches up', () => {
    const sim = InventorySimulation.create(scarceSeed(), now);
    // 30 days at 10,000 a day, minus 40,000 lost in the outage, leaves
    // 260,000 of supply for a 200,000 goal.
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 200_000 }, now);
    sim.advanceTo(at('2027-01-31T00:00:00Z'));
    const days = sim.booking('g').days;
    const outage = days.filter(day => day.date >= '2027-01-06' && day.date <= '2027-01-10');
    expect(outage.every(day => day.impressions < day.target!)).toBe(true);
    const before = days.find(day => day.date === '2027-01-05')!.target!;
    const after = days.find(day => day.date === '2027-01-11')!.target!;
    expect(after).toBeGreaterThan(before);
    expect(days.every(day => day.impressions <= day.target!)).toBe(true);
    expect(sim.booking('g').delivered.impressions).toBe(200_000);
    expect(sim.booking('g').delivered.spend).toBe(2000);
  });

  it('bills spend from cumulative impressions, so daily rounding never drifts the total', () => {
    const seed = scarceSeed();
    seed.products[0].rate_cpm = 14;
    const sim = InventorySimulation.create(seed, now);
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 180_000 }, now);
    sim.book({ booking_id: 'n', product_id: 'banner_auction', ...flight, budget: 1_000_000, bid_cpm: 3.333 }, now);
    sim.advanceTo(at('2027-01-15T06:00:00Z'));
    sim.update('n', { bid_cpm: 2.777 }, at('2027-01-15T06:00:00Z'));
    sim.advanceTo(at('2027-01-31T00:00:00Z'));
    const g = sim.booking('g');
    expect(g.delivered.impressions).toBe(180_000);
    expect(g.delivered.spend).toBe(2520);
    for (const booking of [g, sim.booking('n')]) {
      const daily = booking.days.reduce((sum, day) => sum + Math.round(day.spend * 100), 0);
      expect(daily).toBe(Math.round(booking.delivered.spend * 100));
    }
    const n = sim.booking('n');
    const before = n.days.filter(day => day.date < '2027-01-15').reduce((sum, day) => sum + day.impressions, 0);
    const after = n.delivered.impressions - before;
    expect(n.delivered.spend).toBe(Math.round(((before * 3.333) / 1000 + (after * 2.777) / 1000) * 100) / 100);
  });

  it('gives non-guaranteed bookings only what guarantees leave, first-price', () => {
    const sim = InventorySimulation.create(scarceSeed(), now);
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 150_000 }, now);
    sim.book({ booking_id: 'n', product_id: 'banner_auction', ...flight, budget: 1_000_000, bid_cpm: 3 }, now);
    sim.advanceTo(at('2027-01-31T00:00:00Z'));
    const g = sim.booking('g');
    const n = sim.booking('n');
    expect(g.delivered.impressions).toBe(150_000);
    for (const day of n.days) {
      const guaranteed = g.days.find(other => other.day === day.day)!.impressions;
      const supply = sim.traffic.day(day.day).actual.get(0)! + sim.traffic.day(day.day).actual.get(1)!;
      expect(day.impressions).toBe(supply - guaranteed);
      expect(day.spend).toBeCloseTo((day.impressions * 3) / 1000, 2);
    }
  });

  it('subtracts guaranteed bookings from the forecast and returns the AdCP shape', () => {
    const sim = InventorySimulation.create(scarceSeed(), now);
    const before = sim.forecast({ product_id: 'banner_guaranteed', ...flight }, now);
    expect(before.available).toBe(300_000);
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 100_000 }, now);
    const after = sim.forecast({ product_id: 'banner_guaranteed', ...flight }, now);
    expect(after.booked).toBe(100_000);
    expect(after.available).toBe(200_000);
    const shaped = toAdcpForecast(after, { guaranteed: true, generatedAt: '2026-12-31T12:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' });
    expect(shaped.points[0].metrics.impressions.mid).toBe(200_000);
    expect(shaped.method).toBe('guaranteed');
    expect(shaped.forecast_range_unit).toBe('availability');
  });

  it('releases a day of delivery only after the day closes and the lag passes', () => {
    const sim = InventorySimulation.create(scarceSeed(), now);
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 100_000 }, now);
    expect(sim.delivery('g', at('2027-01-01T23:00:00Z')).days).toHaveLength(0);
    const report = sim.delivery('g', at('2027-01-02T01:00:00Z'));
    expect(report.days.map(day => day.date)).toEqual(['2027-01-01']);
    expect(report.reported_through_day).toBe(0);
  });

  it('is deterministic: the same calls give the same state', () => {
    const run = () => {
      const sim = InventorySimulation.create(ADSERVER_SEASON, now);
      sim.book({ booking_id: 'g', product_id: 'ros_display_guaranteed', ...flight, budget: 50_000, impression_goal: 3_000_000 }, now);
      sim.book({ booking_id: 't', product_id: 'homepage_takeover_daily', flight_start_ms: at('2027-01-10'), flight_end_ms: at('2027-01-11'), budget: 2000 }, now);
      sim.book({ booking_id: 'n', product_id: 'ros_display_auction', ...flight, budget: 20_000, bid_cpm: 3.5 }, now);
      sim.advanceTo(at('2027-01-15T06:00:00Z'));
      sim.update('n', { bid_cpm: 5 }, at('2027-01-15T06:00:00Z'));
      sim.advanceTo(at('2027-02-02T00:00:00Z'));
      return sim.state;
    };
    expect(run()).toEqual(run());
  });

  it('refuses a second share-of-voice booking on the same cells', () => {
    const sim = InventorySimulation.create(ADSERVER_SEASON, now);
    const day = { flight_start_ms: at('2027-01-10'), flight_end_ms: at('2027-01-11') };
    sim.book({ booking_id: 't1', product_id: 'homepage_takeover_daily', ...day, budget: 2000 }, now);
    expectEngineError(() => sim.book({ booking_id: 't2', product_id: 'homepage_takeover_daily', ...day, budget: 2000 }, now), 'SOLD_OUT');
  });

  describe('goal against forecast (#9198)', () => {
    const ros = { product_id: 'ros_display_guaranteed', flight_start_ms: at('2027-02-01T00:00:00Z'), flight_end_ms: at('2027-03-01T00:00:00Z') };
    const goal = (booking_id: string, impression_goal: number) => ({ booking_id, ...flight, product_id: 'banner_guaranteed', budget: 100_000, impression_goal });

    it('refuses a second 75% goal once the first holds the forecast', () => {
      const sim = InventorySimulation.create(ADSERVER_SEASON, now);
      const available = sim.forecast(ros, now).available;
      expect(available).toBe(12_262_579);
      const share = Math.floor(available * 0.75);
      expect(share).toBe(9_196_934);
      sim.book({ ...ros, booking_id: 'a', budget: 1_000_000, impression_goal: share }, now);
      const left = sim.forecast(ros, now).available;
      expect(left).toBe(3_065_645);
      let caught: unknown;
      try {
        sim.book({ ...ros, booking_id: 'b', budget: 1_000_000, impression_goal: share }, now);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EngineError);
      expect((caught as EngineError).code).toBe('INSUFFICIENT_INVENTORY');
      expect((caught as EngineError).message).toContain(String(share));
      expect((caught as EngineError).message).toContain(String(left));
      expect(() => sim.booking('b')).toThrow();
    });

    it('accepts a goal that exactly fits what is left', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      sim.book(goal('a', 100_000), now);
      sim.book(goal('b', 200_000), now);
      expect(sim.forecast({ product_id: 'banner_guaranteed', ...flight }, now).available).toBe(0);
      expectEngineError(() => sim.book(goal('c', 1), now), 'INSUFFICIENT_INVENTORY');
    });

    it('refuses a goal one impression over what is left', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      sim.book(goal('a', 100_000), now);
      expectEngineError(() => sim.book(goal('b', 200_001), now), 'INSUFFICIENT_INVENTORY');
    });

    it('refuses a goal the budget derives that is over the forecast', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      const { impression_goal: _goal, ...base } = goal('a', 0);
      // $4,000 at a $10 CPM is 400,000 impressions against 300,000 of supply.
      expectEngineError(() => sim.book({ ...base, budget: 4000 }, now), 'INSUFFICIENT_INVENTORY');
      sim.book({ ...base, budget: 3000 }, now);
      expect(sim.booking('a').impression_goal).toBe(300_000);
    });

    it('refuses a raised goal over what is left, excluding its own reservation', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      sim.book(goal('a', 100_000), now);
      sim.book(goal('b', 100_000), now);
      expectEngineError(() => sim.update('a', { impression_goal: 200_001 }, now), 'INSUFFICIENT_INVENTORY');
      expect(sim.booking('a').impression_goal).toBe(100_000);
      sim.update('a', { impression_goal: 200_000 }, now);
      expect(sim.booking('a').impression_goal).toBe(200_000);
    });

    it('leaves the whole patch unapplied when the raised goal is refused', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      sim.book(goal('a', 100_000), now);
      expectEngineError(() => sim.update('a', { impression_goal: 400_000, budget: 5 }, now), 'INSUFFICIENT_INVENTORY');
      expect(sim.booking('a').budget).toBe(100_000);
    });

    it('weighs a raise against what is delivered and the days still to serve', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      sim.book(goal('a', 100_000), now);
      const later = at('2027-01-11T12:00:00Z');
      sim.advanceTo(later);
      const delivered = sim.booking('a').delivered.impressions;
      expect(delivered).toBeGreaterThan(0);
      // Only A is booked, and today (Jan 11) has not run, so what is open to
      // it is the forecast of Jan 11 through Jan 30.
      let open = 0;
      for (let day = 10; day < 30; day++) for (const value of sim.traffic.day(day).forecast.values()) open += value;
      expect(open).toBe(200_000);
      let caught: unknown;
      try {
        sim.update('a', { impression_goal: delivered + open + 1 }, later);
      } catch (error) {
        caught = error;
      }
      expect((caught as EngineError).code).toBe('INSUFFICIENT_INVENTORY');
      expect((caught as EngineError).message).toContain('still to deliver');
      expect(sim.booking('a').impression_goal).toBe(100_000);
      sim.update('a', { impression_goal: delivered + open }, later);
      expect(sim.booking('a').impression_goal).toBe(delivered + open);
    });

    it('accepts a raise on the last serving day', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      sim.book(goal('a', 100_000), now);
      const last = at('2027-01-30T12:00:00Z');
      sim.advanceTo(last);
      sim.update('a', { impression_goal: 100_001 }, last);
      expect(sim.booking('a').impression_goal).toBe(100_001);
    });

    it('starts a new booking from tomorrow, not today', () => {
      const midSeason = at('2027-01-11T12:00:00Z');
      const sim = InventorySimulation.create(scarceSeed(), midSeason);
      // Jan 12 through Jan 30 is 19 days.
      expect(sim.forecast({ product_id: 'banner_guaranteed', ...flight }, midSeason).capacity).toBe(190_000);
      expectEngineError(() => sim.book(goal('a', 190_001), midSeason), 'INSUFFICIENT_INVENTORY');
      sim.book(goal('a', 190_000), midSeason);
    });

    describe('re-checking raised goals over overlapping cells', () => {
      const placement = (placement_id: string) => ({
        placement_id,
        name: placement_id,
        channel: 'display' as const,
        property_ids: ['site'],
        formats: ['display_300x250'],
        base_daily_impressions: 10_000,
        floor_cpm: 2,
        rates: { viewability: 0.7, click_rate: 0.001, completion_rate: 0, conversion_rate: 0.02 },
        reporting_lag_days: 0,
      });
      const product = (product_id: string, placement_ids: string[]) =>
        ({ product_id, name: product_id, description: product_id, delivery_type: 'guaranteed' as const, placement_ids, rate_cpm: 10 });
      const overlapSeed = () => scarceSeed({
        placements: [placement('p1'), placement('p2')],
        products: [
          product('broad', ['p1', 'p2']),
          product('narrow', ['p2']),
          { product_id: 'auction', name: 'Auction', description: 'Auction', delivery_type: 'non_guaranteed', placement_ids: ['p1'] },
        ],
      });
      const book = (sim: InventorySimulation, booking_id: string, product_id: string, impression_goal: number) =>
        sim.book({ booking_id, product_id, ...flight, budget: 100_000, impression_goal }, now);

      it('squeezes the earlier raise when a later one takes its cells, whatever the order', () => {
        const sim = InventorySimulation.create(overlapSeed(), now);
        expect(sim.forecast({ product_id: 'broad', ...flight }, now).capacity).toBe(600_000);
        expect(sim.forecast({ product_id: 'narrow', ...flight }, now).capacity).toBe(300_000);
        book(sim, 'A', 'broad', 300_000);
        book(sim, 'B', 'narrow', 100_000);
        // Each raise fits at its own step: B against A's 150k on p2, then A
        // against B's new 150k.
        sim.update('B', { impression_goal: 150_000 }, now);
        sim.update('A', { impression_goal: 450_000 }, now);
        // The final state is what decides, so the batch fails whatever its order.
        expectEngineError(() => sim.requireGoalAvailable('B', now), 'INSUFFICIENT_INVENTORY');
        sim.requireGoalAvailable('A', now);

        const other = InventorySimulation.create(overlapSeed(), now);
        book(other, 'A', 'broad', 300_000);
        book(other, 'B', 'narrow', 100_000);
        other.update('A', { impression_goal: 450_000 }, now);
        expectEngineError(() => other.update('B', { impression_goal: 150_000 }, now), 'INSUFFICIENT_INVENTORY');
      });

      it('has nothing to check on a booking without a goal', () => {
        const sim = InventorySimulation.create(overlapSeed(), now);
        sim.book({ booking_id: 'n', product_id: 'auction', ...flight, budget: 1_000_000, bid_cpm: 3 }, now);
        sim.requireGoalAvailable('n', now);
      });
    });

    it('accepts an unchanged or lowered goal', () => {
      const sim = InventorySimulation.create(scarceSeed(), now);
      sim.book(goal('a', 150_000), now);
      sim.book(goal('b', 150_000), now);
      sim.update('a', { impression_goal: 150_000 }, now);
      sim.update('a', { impression_goal: 50_000 }, now);
      expect(sim.booking('a').impression_goal).toBe(50_000);
    });

    it('holds only the in-window share of a booking when the forecast starts mid-flight', () => {
      const sim = InventorySimulation.create(ADSERVER_SEASON, now);
      const whole = sim.forecast(ros, now);
      const share = Math.floor(whole.available * 0.75);
      sim.book({ ...ros, booking_id: 'a', budget: 1_000_000, impression_goal: share }, now);
      const mid = sim.forecast({ ...ros, flight_start_ms: at('2027-02-15T00:00:00Z') }, now);
      expect(mid.capacity).toBeLessThan(whole.capacity);
      expect(mid.booked).toBeGreaterThan(0);
      expect(mid.available).toBeGreaterThan(0);
      expect(Math.abs(mid.booked - (share * mid.capacity) / whole.capacity)).toBeLessThanOrEqual(1);
    });
  });

  describe('traffic-following pacing', () => {
    const exactSeed = (): SeasonSeed => {
      const seed = structuredClone(ADSERVER_SEASON);
      seed.forecast_error = { bias: 0, day_sigma: 0, cell_sigma: 0 };
      seed.events = [];
      return seed;
    };
    const EXACT = exactSeed();
    const bookedAt = at('2026-12-31T12:00:00Z');
    const starts = { sunday: '2027-01-03T00:00:00Z', wednesday: '2027-01-06T00:00:00Z' } as const;
    const flightFrom = (iso: string) => ({
      product_id: 'ros_display_guaranteed',
      flight_start_ms: at(iso),
      flight_end_ms: at(iso) + 30 * 86_400_000,
    });
    const runThrough = (sim: InventorySimulation, iso: string) => sim.advanceTo(at(iso) + 31 * 86_400_000);

    for (const [name, iso] of Object.entries(starts)) {
      it(`delivers a lone run-of-site goal in full with exact traffic, starting on a ${name}`, () => {
        const sim = InventorySimulation.create(EXACT, bookedAt);
        const available = sim.forecast(flightFrom(iso), bookedAt).available;
        sim.book({ ...flightFrom(iso), booking_id: 'a', budget: 10_000_000, impression_goal: available }, bookedAt);
        runThrough(sim, iso);
        expect(sim.booking('a').delivered.impressions).toBeGreaterThanOrEqual(available - 30);
        expect(sim.booking('a').delivered.impressions).toBeLessThanOrEqual(available);
      });

      it(`sells the second booking exactly what the first leaves, starting on a ${name}`, () => {
        const sim = InventorySimulation.create(EXACT, bookedAt);
        const whole = sim.forecast(flightFrom(iso), bookedAt).available;
        const a = Math.floor(whole * 0.75);
        sim.book({ ...flightFrom(iso), booking_id: 'a', budget: 10_000_000, impression_goal: a }, bookedAt);
        const available = sim.forecast(flightFrom(iso), bookedAt).available;
        expect(Math.abs(available - (whole - a))).toBeLessThanOrEqual(2);
        sim.book({ ...flightFrom(iso), booking_id: 'b', budget: 10_000_000, impression_goal: available }, bookedAt);
        runThrough(sim, iso);
        expect(sim.booking('a').delivered.impressions).toBeGreaterThanOrEqual(a - 30);
        expect(sim.booking('b').delivered.impressions).toBeGreaterThanOrEqual(available - 30);
      });
    }

    it('re-plans each day in proportion to the traffic left, so a shortfall is made up by the flight end', () => {
      const shape = [0.6, 1, 1.2, 1.2, 1, 1, 0.8];
      const sim = InventorySimulation.create(scarceSeed({ traffic: { weekday_shape: shape } }), now);
      sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 200_000 }, now);
      sim.advanceTo(at('2027-01-31T00:00:00Z'));
      const booking = sim.booking('g');
      const forecastOf = (day: number) => [...sim.traffic.day(day).forecast.values()].reduce((sum, value) => sum + value, 0);
      let left = 200_000;
      for (const record of booking.days) {
        const day = sim.traffic.calendar.dayOf(at(`${record.date}T00:00:00Z`));
        let sumF = 0;
        for (let d = day; d < booking.flight_end_day; d++) sumF += forecastOf(d);
        const expected = Math.max(0, Math.min(left, Math.ceil((left * forecastOf(day)) / sumF - 1e-9)));
        expect(record.target).toBe(expected);
        left -= record.impressions;
      }
      const target = (date: string) => booking.days.find(record => record.date === date)!.target!;
      // 2027-01-03 is a Sunday (0.6), 2027-01-05 a Tuesday (1.2): before the outage the plan follows the shape.
      expect(target('2027-01-05') / target('2027-01-03')).toBeCloseTo(2, 1);
      const perUnit = (date: string) => target(date) / forecastOf(sim.traffic.calendar.dayOf(at(`${date}T00:00:00Z`)));
      expect(perUnit('2027-01-11')).toBeGreaterThan(perUnit('2027-01-05'));
      expect(booking.delivered.impressions).toBe(200_000);
    });

    it('delivers all that is left on the last in-season day, and falls back to a flat rule past the season', () => {
      const sim = InventorySimulation.create(scarceSeed(), at('2027-02-20T12:00:00Z'));
      const bookNow = at('2027-02-20T12:00:00Z');
      sim.book({
        booking_id: 'g',
        product_id: 'banner_guaranteed',
        flight_start_ms: at('2027-02-25T00:00:00Z'),
        flight_end_ms: at('2027-03-10T00:00:00Z'),
        budget: 100_000,
        impression_goal: 40_000,
      }, bookNow);
      sim.advanceTo(at('2027-03-11T00:00:00Z'));
      const days = sim.booking('g').days;
      const last = days.find(day => day.date === '2027-03-01')!;
      expect(last.target).toBe(40_000 - days.filter(day => day.date < '2027-03-01').reduce((sum, day) => sum + day.impressions, 0));
      expect(sim.booking('g').delivered.impressions).toBe(40_000);
    });

    it('reports a traffic-weighted pace, so an on-plan booking reads about 1 every day', () => {
      const sim = InventorySimulation.create(EXACT, bookedAt);
      const iso = starts.sunday;
      const available = sim.forecast(flightFrom(iso), bookedAt).available;
      sim.book({ ...flightFrom(iso), booking_id: 'a', budget: 10_000_000, impression_goal: available }, bookedAt);
      for (let offset = 1; offset <= 30; offset++) {
        const nowMs = at(iso) + offset * 86_400_000 + 3_600_000;
        const report = sim.delivery('a', nowMs);
        if (report.expected_impressions === undefined) continue;
        const index = report.totals.impressions / report.expected_impressions;
        expect(Math.abs(index - 1)).toBeLessThan(0.001);
      }
    });
  });

  it('pauses and cancels', () => {
    const sim = InventorySimulation.create(scarceSeed(), now);
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 10_000, impression_goal: 100_000 }, now);
    sim.advanceTo(at('2027-01-03T00:00:00Z'));
    sim.update('g', { status: 'paused' }, at('2027-01-03T00:00:00Z'));
    sim.advanceTo(at('2027-01-05T00:00:00Z'));
    expect(sim.booking('g').days).toHaveLength(2);
    sim.update('g', { status: 'canceled' }, at('2027-01-05T00:00:00Z'));
    expect(() => sim.update('g', { status: 'active' }, at('2027-01-05T00:00:00Z'))).toThrow(/canceled/);
  });
});

describe('installments', () => {
  const now = at('2026-12-31T12:00:00Z');

  it('delivers nothing for a cancelled episode and reports it once its date passes', () => {
    const sim = InventorySimulation.create(CONTENT_SEASON, now);
    const flight = { flight_start_ms: at('2027-01-01'), flight_end_ms: at('2027-03-01') };
    sim.book({ booking_id: 'ran', product_id: 'morning_brief_midroll', targeting: { installment_ids: ['morning_brief_011'] }, ...flight, budget: 5000 }, now);
    sim.book({ booking_id: 'cut', product_id: 'morning_brief_midroll', targeting: { installment_ids: ['morning_brief_012'] }, ...flight, budget: 5000 }, now);
    const forecast = sim.forecast({ product_id: 'morning_brief_midroll', targeting: { installment_ids: ['morning_brief_013'] }, ...flight }, now);
    expect(forecast.available).toBeGreaterThan(35_000);

    const statusOn = (iso: string) => sim.installmentStatuses(at(iso), 'morning_brief_midroll')
      .find(installment => installment.installment_id === 'morning_brief_012')!.state;
    expect(statusOn('2027-01-17T12:00:00Z')).toBe('scheduled');
    expect(statusOn('2027-01-18T12:00:00Z')).toBe('cancelled');

    const end = at('2027-03-01T12:00:00Z');
    expect(sim.delivery('cut', end).totals.impressions).toBe(0);
    const ran = sim.delivery('ran', end);
    expect(ran.totals.impressions).toBeGreaterThan(30_000);
    // Listens arrive over 30 days from 2027-01-11.
    const listened = ran.days.filter(day => day.impressions > 0);
    expect(listened).toHaveLength(30);
    expect(listened[0].date).toBe('2027-01-11');
    expect(listened[0].impressions).toBeGreaterThan(listened[10].impressions);
    expect(sim.state.log.find(entry => entry.date === '2027-01-18')!.installments)
      .toContainEqual({ installment_id: 'morning_brief_012', outcome: 'cancelled' });
  });

  it('moves a postponed installment to its new date', () => {
    const sim = InventorySimulation.create(CONTENT_SEASON, now);
    const statuses = sim.installmentStatuses(at('2027-01-20T00:00:00Z'), 'maker_studio_integration');
    const moved = statuses.find(installment => installment.installment_id === 'maker_studio_006')!;
    expect(moved.state).toBe('postponed');
    expect(moved.rescheduled_date).toBe('2027-01-23');
    const cells = sim.traffic.eligibleCells('maker_studio_integration', { installment_ids: ['maker_studio_006'] });
    const actualOn = (date: string) => cells.reduce((sum, cell) => sum + (sim.traffic.day(sim.traffic.calendar.dayOfDate(date)).actual.get(cell) ?? 0), 0);
    const forecastOn = (date: string) => cells.reduce((sum, cell) => sum + (sim.traffic.day(sim.traffic.calendar.dayOfDate(date)).forecast.get(cell) ?? 0), 0);
    expect(forecastOn('2027-01-18')).toBeGreaterThan(0);
    expect(actualOn('2027-01-18')).toBe(0);
    expect(actualOn('2027-01-23')).toBeGreaterThan(0);
  });
});
