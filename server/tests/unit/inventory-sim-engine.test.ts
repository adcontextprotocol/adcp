/**
 * #9025 part B: the deterministic inventory delivery engine behind the
 * training agent's inventory tenants. Allocation primitives, traffic
 * generation, the day steps, forecasts, installments and reporting delay.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ADSERVER_SEASON,
  CONTENT_SEASON,
  ENGINE_VERSION,
  EngineError,
  InventorySimulation,
  SeasonTraffic,
  allocateAuction,
  allocateHighWaterMark,
  audienceCurve,
  takeEqualShare,
  standardNormal,
  takeShareOfVoice,
  toAdcpForecast,
  uniform,
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

const ZERO_FORECAST_ERROR: SeasonSeed['forecast_error'] = {
  channel_sigma: { display: 0 },
  ar1_phi: 0,
  lead_time_tau_days: 14,
  lead_time_horizon_days: 60,
  log_clip: 0.6931471805599453,
  cell_kappa: 0,
  cell_min_impressions: 100,
};
const NOISY_FORECAST_ERROR: SeasonSeed['forecast_error'] = {
  ...ZERO_FORECAST_ERROR,
  channel_sigma: { display: 0.1 },
  cell_kappa: 1,
};

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
    forecast_error: ZERO_FORECAST_ERROR,
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
    const noisy = scarceSeed({
      forecast_error: NOISY_FORECAST_ERROR,
      traffic: { weekday_shape: [1, 1, 1, 1, 1, 1, 1], truth_daily_sigma: 0.05 },
    });
    const a = new SeasonTraffic(noisy);
    const b = new SeasonTraffic(noisy);
    const c = new SeasonTraffic({ ...noisy, rng_seed: 'other' });
    for (let day = 0; day < 60; day++) {
      expect([...a.day(day).actual]).toEqual([...b.day(day).actual]);
      expect(a.rates(day, 0)).toEqual(b.rates(day, 0));
      for (const asOf of [0, 30]) {
        for (let cell = 0; cell < a.slots.length; cell++) {
          expect(a.forecastValue(day, cell, asOf)).toBe(b.forecastValue(day, cell, asOf));
        }
      }
    }
    expect([...a.day(3).actual]).not.toEqual([...c.day(3).actual]);
    expect(a.forecastValue(3, 0, 0)).not.toBe(c.forecastValue(3, 0, 0));
    expect(a.forecastValue(40, 1, 30)).not.toBe(c.forecastValue(40, 1, 30));
  });

  it('keeps expected and actual apart by forecast error, the daily wobble and events', () => {
    const traffic = new SeasonTraffic(ADSERVER_SEASON);
    let expected = 0;
    let actual = 0;
    let differing = 0;
    for (let day = 60; day < 90; day++) {
      const tables = traffic.day(day);
      for (const [cell, value] of tables.expected) {
        expected += value;
        actual += tables.actual.get(cell) ?? 0;
        if ((tables.actual.get(cell) ?? 0) !== value) differing += 1;
      }
    }
    expect(actual).not.toBe(expected);
    expect(differing).toBeGreaterThan(100);
    expect(Math.abs(actual / expected - 1)).toBeLessThan(0.15);

    // With no forecast error, wobble, spikes or events, actual is expected.
    const quiet = new SeasonTraffic(scarceSeed({ events: [] }));
    for (let day = 0; day < 60; day++) expect([...quiet.day(day).actual]).toEqual([...quiet.day(day).expected]);
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

  it('prices a guaranteed booking at the rate it is booked with, not the product rate (#9208)', () => {
    const sim = InventorySimulation.create(scarceSeed(), now);
    // The product lists $10; a $400 budget at the chosen $4 buys 100,000, not 40,000.
    sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 400, rate_cpm: 4 }, now);
    expect(sim.booking('g').cpm).toBe(4);
    expect(sim.booking('g').impression_goal).toBe(100_000);
    sim.advanceTo(at('2027-01-31T00:00:00Z'));
    const g = sim.booking('g');
    expect(g.delivered.impressions).toBeGreaterThan(99_990);
    expect(g.delivered.impressions).toBeLessThanOrEqual(100_000);
    expect(g.delivered.spend).toBeCloseTo((g.delivered.impressions * 4) / 1000, 2);
  });

  it('refuses a non-positive booking rate', () => {
    const sim = InventorySimulation.create(scarceSeed(), now);
    for (const rate_cpm of [0, -1]) {
      expect(() => sim.book({ booking_id: 'g', product_id: 'banner_guaranteed', ...flight, budget: 400, rate_cpm }, now))
        .toThrow(expect.objectContaining({ code: 'INVALID_BOOKING' }));
    }
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
    /** The forecast of a product's cells over the days [first, last) as known on `asOf`, summed unrounded. */
    const forecastSum = (sim: InventorySimulation, productId: string, first: number, last: number, asOf: number) => {
      let sum = 0;
      for (const cell of sim.traffic.eligibleCells(productId)) {
        for (let day = first; day < last; day++) sum += sim.traffic.forecastValue(day, cell, asOf);
      }
      return sum;
    };

    it('refuses a second 75% goal once the first holds the forecast', () => {
      const sim = InventorySimulation.create(ADSERVER_SEASON, now);
      const { calendar } = sim.traffic;
      // With nothing booked, what is available is the forecast as known today over the flight's days, rounded once.
      const capacity = forecastSum(sim, ros.product_id, calendar.dayOf(ros.flight_start_ms), calendar.dayOf(ros.flight_end_ms), sim.today(now));
      const available = sim.forecast(ros, now).available;
      expect(available).toBe(Math.round(capacity));
      const share = Math.floor(available * 0.75);
      sim.book({ ...ros, booking_id: 'a', budget: 1_000_000, impression_goal: share }, now);
      // The first goal holds `share` of the forecast, an integer, so what is left is `available` less `share`.
      const left = sim.forecast(ros, now).available;
      expect(Math.abs(left - (available - share))).toBeLessThanOrEqual(1);
      expect(left).toBeLessThan(share);
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
      // it is the forecast of Jan 11 through Jan 30 as known today: summed
      // unrounded, then rounded once. With no forecast error that is 20 days
      // of 10,000 impressions.
      const today = sim.today(later);
      const open = Math.round(forecastSum(sim, 'banner_guaranteed', today, sim.booking('a').flight_end_day, today));
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
    // Every truth term is zero (publisher shocks, cell shock, daily variation, bias, events), so the
    // traffic delivered is the traffic expected and the forecast is that traffic as well.
    const exactSeed = (): SeasonSeed => {
      const seed = structuredClone(ADSERVER_SEASON);
      seed.forecast_error = { ...ZERO_FORECAST_ERROR, channel_sigma: { display: 0, olv: 0 } };
      seed.traffic.truth_daily_sigma = 0;
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
      // Goals pace against the expected table, the rounded expected traffic every forecast shares.
      const expectedOf = (day: number) => [...sim.traffic.day(day).expected.values()].reduce((sum, value) => sum + value, 0);
      let left = 200_000;
      for (const record of booking.days) {
        const day = sim.traffic.calendar.dayOf(at(`${record.date}T00:00:00Z`));
        let sumE = 0;
        for (let d = day; d < booking.flight_end_day; d++) sumE += expectedOf(d);
        const expected = Math.max(0, Math.min(left, Math.ceil((left * expectedOf(day)) / sumE - 1e-9)));
        expect(record.target).toBe(expected);
        left -= record.impressions;
      }
      const target = (date: string) => booking.days.find(record => record.date === date)!.target!;
      // 2027-01-03 is a Sunday (0.6), 2027-01-05 a Tuesday (1.2): before the outage the plan follows the shape.
      expect(target('2027-01-05') / target('2027-01-03')).toBeCloseTo(2, 1);
      const perUnit = (date: string) => target(date) / expectedOf(sim.traffic.calendar.dayOf(at(`${date}T00:00:00Z`)));
      expect(perUnit('2027-01-11')).toBeGreaterThan(perUnit('2027-01-05'));
      expect(booking.delivered.impressions).toBe(200_000);
    });

    it('targets everything left on the last in-season day of a flight that runs past the season', () => {
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
    const expectedOn = (date: string) => cells.reduce((sum, cell) => sum + (sim.traffic.day(sim.traffic.calendar.dayOfDate(date)).expected.get(cell) ?? 0), 0);
    expect(expectedOn('2027-01-18')).toBeGreaterThan(0);
    expect(actualOn('2027-01-18')).toBe(0);
    expect(actualOn('2027-01-23')).toBeGreaterThan(0);
  });
});

describe('lead-time forecast error', () => {
  const DAYS = 1100;
  const FLAT = [1, 1, 1, 1, 1, 1, 1];
  const NO_ERROR: SeasonSeed['forecast_error'] = {
    channel_sigma: { display: 0, olv: 0 },
    ar1_phi: 0.85,
    lead_time_tau_days: 14,
    lead_time_horizon_days: 60,
    log_clip: 50,
    cell_kappa: 0,
    cell_min_impressions: 100,
  };

  interface SynthOptions {
    publishers?: number;
    base?: number;
    error?: Partial<SeasonSeed['forecast_error']>;
    traffic?: Partial<SeasonSeed['traffic']>;
    events?: SeasonSeed['events'];
    sharedProperty?: boolean;
  }

  /** Twenty single-property publishers, each with one display placement, one region and one
   * profile, so cell `i` is publisher `i` and its expected traffic is `base` every day. With
   * `sharedProperty`, one property carries a display placement (cell 0) and an olv placement (cell 1). */
  function synthSeed(options: SynthOptions = {}): SeasonSeed {
    const { publishers = 20, base = 10_000, error = {}, traffic = {}, events } = options;
    const ids = options.sharedProperty ? ['site'] : Array.from({ length: publishers }, (_, i) => `site_${i}`);
    const placement = (id: string, channel: 'display' | 'olv', propertyId: string) => ({
      placement_id: id,
      name: id,
      channel,
      property_ids: [propertyId],
      formats: ['display_300x250'],
      base_daily_impressions: base,
      floor_cpm: 1,
      rates: { viewability: 0.7, click_rate: 0.001, completion_rate: 0, conversion_rate: 0.02 },
      reporting_lag_days: 0,
    });
    return {
      seed_id: 'synth',
      rng_seed: 'synth-v1',
      start_date: '2027-01-01',
      days: DAYS,
      currency: 'USD',
      regions: [{ region_id: 'r1', country: 'US', name: 'Region one', share: 1 }],
      audience_profiles: [{ profile_id: 'p1', name: 'Profile one', share: 1 }],
      segments: [],
      properties: ids.map(id => ({ property_id: id, name: id, domain: `${id}.example` })),
      placements: options.sharedProperty
        ? [placement('pl_display', 'display', 'site'), placement('pl_olv', 'olv', 'site')]
        : ids.map(id => placement(`pl_${id}`, 'display', id)),
      products: [],
      traffic: { weekday_shape: FLAT, ...traffic },
      forecast_error: { ...NO_ERROR, ...error },
      ...(events ? { events } : {}),
    };
  }

  const PHI = 0.85;
  const TAU = 14;
  const HORIZON = 60;
  const RNG = 'synth-v1';

  /** `x_p(t)`, redrawn from its keys: AR(1) from day 0. */
  function sameDayShock(publisher: string, day: number, phi = PHI): number {
    let x = 0;
    for (let t = 0; t <= day; t++) {
      const fresh = standardNormal(`${RNG}|fe-x|${publisher}|${t}`);
      x = t === 0 ? fresh : phi * x + Math.sqrt(1 - phi * phi) * fresh;
    }
    return x;
  }

  /** `z_p(t, r)`, redrawn from its keys: AR(1) in `t` from `r + 1`. */
  function revisionShock(publisher: string, day: number, revealedOn: number, phi = PHI): number {
    let z = 0;
    for (let t = revealedOn + 1; t <= day; t++) {
      const fresh = standardNormal(`${RNG}|fe-rev|${publisher}|${t}|${revealedOn}`);
      z = t === revealedOn + 1 ? fresh : phi * z + Math.sqrt(1 - phi * phi) * fresh;
    }
    return z;
  }

  const sd = (values: number[]) => {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
  };

  const correlation = (xs: number[], ys: number[]) => {
    const mx = xs.reduce((sum, v) => sum + v, 0) / xs.length;
    const my = ys.reduce((sum, v) => sum + v, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    xs.forEach((x, i) => {
      sxy += (x - mx) * (ys[i] - my);
      sxx += (x - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    });
    return sxy / Math.sqrt(sxx * syy);
  };

  /** The cache of the seeds the statistical tests share; each costs millions of draws to build. */
  const built = new Map<string, SeasonTraffic>();
  const sharedTraffic = (key: string, seed: () => SeasonSeed): SeasonTraffic => {
    if (!built.has(key)) built.set(key, new SeasonTraffic(seed()));
    return built.get(key)!;
  };

  const SMALL_A = 0.05;
  /** 100 single-property publishers over 1 100 days, publisher scale 0.05, no cell shock, no daily wobble. */
  const statSeed = () => synthSeed({ publishers: 100, base: 1_000_000, error: { channel_sigma: { display: SMALL_A } } });
  const statTraffic = () => sharedTraffic('stat', statSeed);

  /** `ln(actual / forecast)` of a cell-day made on an as-of day. */
  const logMiss = (traffic: SeasonTraffic, day: number, cell: number, asOf: number) =>
    Math.log(traffic.day(day).actual.get(cell)! / traffic.forecastValue(day, cell, asOf));
  /** The truth deviation `Δ`, read off a seed with no wobble, spikes or events. */
  const deviation = (traffic: SeasonTraffic, day: number, cell: number) =>
    Math.log(traffic.day(day).actual.get(cell)! / traffic.day(day).expected.get(cell)!);

  it('knows the revealed shocks and nothing else, one as-of day at a time', () => {
    const base = 10_000;
    const traffic = new SeasonTraffic(synthSeed({ base, error: { channel_sigma: { display: 0.05 }, log_clip: 50 } }));
    const known = (day: number, cell: number, asOf: number) => Math.log(traffic.forecastValue(day, cell, asOf) / base);
    const scale = traffic.publisherScale(0);
    expect(scale).toBeCloseTo(0.05, 12);
    for (const [day, cell] of [[400, 0], [700, 3], [1000, 7]]) {
      const id = `site_${cell}`;
      for (let asOf = day - HORIZON - 4; asOf < day; asOf++) {
        const revision = asOf >= day - HORIZON ? revisionShock(id, day, asOf) / Math.sqrt(TAU) : 0;
        const sameDay = PHI ** (day - asOf) * sameDayShock(id, asOf) - PHI ** (day - asOf + 1) * sameDayShock(id, asOf - 1);
        expect(known(day, cell, asOf + 1) - known(day, cell, asOf)).toBeCloseTo(scale * (revision + sameDay), 9);
      }
      // A forecast knows no revision shock before its window opens and only the decayed past same-day shock.
      for (const asOf of [day - HORIZON, day - HORIZON - 7, day - 200]) {
        expect(known(day, cell, asOf)).toBeCloseTo(scale * PHI ** (day - asOf + 1) * sameDayShock(id, asOf - 1), 9);
      }
      // From the day after, every shock is known and the forecast stops moving.
      const everything = scale * (sameDayShock(id, day) + Array.from({ length: HORIZON }, (_, j) => revisionShock(id, day, day - HORIZON + j)).reduce((sum, z) => sum + z, 0) / Math.sqrt(TAU));
      for (const asOf of [day + 1, day + 2, day + 30]) expect(known(day, cell, asOf)).toBeCloseTo(everything, 9);
      expect(traffic.day(day).actual.get(cell)! / base).toBeCloseTo(Math.exp(everything), 3);
    }
    // Before the first day there is no past shock to know.
    expect(known(300, 0, 0)).toBe(0);
    expect(known(300, 0, -5)).toBe(0);
    // On day 10 (inside the first window) the shocks of days r < 0 are revealed at as-of day 0.
    const early = (cell: number) => {
      const id = `site_${cell}`;
      let sum = 0;
      for (let r = 10 - HORIZON; r < 0; r++) sum += revisionShock(id, 10, r);
      return scale * sum / Math.sqrt(TAU);
    };
    for (const cell of [0, 4]) expect(known(10, cell, 0)).toBeCloseTo(early(cell), 9);
  });

  it('keeps the shocks and the cell shock out of the forecast while the truth carries them', () => {
    const quietError = { channel_sigma: { display: 0.1 }, cell_kappa: 0 };
    const loudError = { channel_sigma: { display: 0.1 }, cell_kappa: 4 };
    const quiet = new SeasonTraffic(synthSeed({ error: quietError }));
    const loud = new SeasonTraffic(synthSeed({ error: loudError, traffic: { truth_daily_sigma: 0.05 } }));
    let actualDiffers = 0;
    for (const asOf of [0, 100, 600]) {
      for (let day = 0; day < DAYS; day += 11) {
        for (let cell = 0; cell < quiet.slots.length; cell++) {
          expect(loud.forecastValue(day, cell, asOf)).toBe(quiet.forecastValue(day, cell, asOf));
          if (loud.day(day).actual.get(cell) !== quiet.day(day).actual.get(cell)) actualDiffers += 1;
        }
      }
    }
    expect(actualDiffers).toBeGreaterThan(1000);
  });

  it('matches the marginal variance of the error at every lead', () => {
    const traffic = statTraffic();
    for (const lead of [0, 1, 7, 30, 60, 200]) {
      const errors: number[] = [];
      for (let cell = 0; cell < traffic.slots.length; cell++) {
        for (let day = lead + 1; day < DAYS; day++) errors.push(logMiss(traffic, day, cell, day - lead));
      }
      const expected = SMALL_A ** 2 * ((1 - PHI ** (2 * (lead + 1))) + Math.min(lead, HORIZON) / TAU);
      const observed = errors.reduce((sum, e) => sum + e * e, 0) / errors.length;
      // Effective sample about 100 × 1 100 × (1 − φ²)/(1 + φ²) ≈ 17 000 correlated draws: the variance estimate has sd ≈ √(2/17 000) ≈ 1%, so ±10% is about 9 sd.
      expect(observed / expected, `lead ${lead}`).toBeGreaterThan(0.9);
      expect(observed / expected, `lead ${lead}`).toBeLessThan(1.1);
    }
  });

  it('cannot be predicted from the truth a seller has seen or from the forecast revisions', () => {
    const traffic = statTraffic();
    const cells = traffic.slots.length;
    const pooled = (read: (day: number, cell: number) => [number, number]) => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let cell = 0; cell < cells; cell++) {
        for (let day = 70; day < DAYS; day++) {
          const [x, y] = read(day, cell);
          xs.push(x);
          ys.push(y);
        }
      }
      return correlation(xs, ys);
    };
    // The truth through day t-2 is all a seller sees at lead 1. Under independence r has sd ≈ 1/√n_eff with n_eff ≈ 17 000 (AR(1) in t), so 0.03 is about 4 sd.
    expect(Math.abs(pooled((day, cell) => [logMiss(traffic, day, cell, day - 1), deviation(traffic, day - 2, cell)]))).toBeLessThan(0.03);
    // The same history does predict the error of a forecast made 30 days before it: the test can see a link. Analytic r = (φ² + 28φ²/τ) / √((1 − φ^62 + 30/τ)(1 + 60/τ)) ≈ 0.53; 0.3 leaves room.
    expect(pooled((day, cell) => [logMiss(traffic, day, cell, day - 30), deviation(traffic, day - 2, cell)])).toBeGreaterThan(0.3);
    for (const lead of [1, 30]) {
      const revisionVersusError = pooled((day, cell) => [
        Math.log(traffic.forecastValue(day, cell, day - lead + 1) / traffic.forecastValue(day, cell, day - lead)),
        logMiss(traffic, day, cell, day - lead + 1),
      ]);
      expect(Math.abs(revisionVersusError), `lead ${lead}`).toBeLessThan(0.03);
    }
  });

  it('puts the publisher and cell shocks and the daily wobble in the truth', () => {
    const traffic = sharedTraffic('truth', () => synthSeed({
      publishers: 100,
      base: 10_000,
      error: { channel_sigma: { display: SMALL_A }, cell_kappa: 1 },
      traffic: { truth_daily_sigma: 0.03 },
    }));
    const ratios: number[] = [];
    for (let cell = 0; cell < traffic.slots.length; cell++) {
      for (let day = 0; day < DAYS; day++) ratios.push(Math.log(traffic.day(day).actual.get(cell)! / traffic.day(day).expected.get(cell)!));
    }
    // sd of a sum of independent terms; with n_eff ≈ 17 000 the sd estimate is within ≈ 0.6%, so ±10% is wide.
    const expected = Math.sqrt(SMALL_A ** 2 * (1 + HORIZON / TAU) + 0.01 ** 2 + 0.03 ** 2);
    expect(sd(ratios) / expected).toBeGreaterThan(0.9);
    expect(sd(ratios) / expected).toBeLessThan(1.1);
  });

  it('shares the publisher shocks across the channels of a property, each scaled by its channel sigma', () => {
    const base = 1e12; // rounding of the table is 1e-12 relative, below the 9-decimal check
    const traffic = new SeasonTraffic(synthSeed({
      sharedProperty: true,
      base,
      error: { channel_sigma: { display: 0.03, olv: 0.08 }, log_clip: 50 },
    }));
    expect(traffic.publisherScale(0)).toBeCloseTo(0.03, 12);
    expect(traffic.publisherScale(1)).toBeCloseTo(0.08, 12);
    let compared = 0;
    for (let day = 100; day < DAYS; day += 37) {
      for (const asOf of [day - 40, day - 5, day]) {
        const display = Math.log(traffic.forecastValue(day, 0, asOf) / base);
        expect(Math.abs(display)).toBeGreaterThan(1e-6);
        expect(Math.log(traffic.forecastValue(day, 1, asOf) / base) / display).toBeCloseTo(0.08 / 0.03, 9);
        compared += 1;
      }
      const truth = (cell: number) => Math.log(traffic.day(day).actual.get(cell)! / base);
      expect(truth(1) / truth(0)).toBeCloseTo(0.08 / 0.03, 9);
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('reads the cell spread, the placement and the centre rates of a cell directly', () => {
    const tiny = new SeasonTraffic(synthSeed({ base: 20, error: { cell_kappa: 1 } }));
    expect(tiny.cellSigma(5, 0)).toBeCloseTo(1 / Math.sqrt(100), 12); // B = 20 is below N_min = 100
    const large = new SeasonTraffic(synthSeed({ base: 10_000, error: { cell_kappa: 1 } }));
    expect(large.cellSigma(5, 0)).toBeCloseTo(1 / Math.sqrt(10_000), 12);
    expect(new SeasonTraffic(synthSeed()).cellSigma(5, 0)).toBe(0);
    expect(large.placementOf(3)).toBe('pl_site_3');

    const seed = scarceSeed({
      audience_profiles: [
        { profile_id: 'p1', name: 'Profile one', share: 0.6, rate_multipliers: { click_rate: 2, viewability: 2 } },
        { profile_id: 'p2', name: 'Profile two', share: 0.4 },
      ],
    });
    const traffic = new SeasonTraffic(seed);
    const [first, second] = [0, 1].map(cell => traffic.expectedRates(cell));
    expect(first.click_rate).toBeCloseTo(0.002, 12);
    expect(first.viewability).toBe(1); // 0.7 x 2 clamps to 1
    expect(first.conversion_rate).toBeCloseTo(0.02, 12);
    expect(second).toEqual({ viewability: 0.7, click_rate: 0.001, completion_rate: 0, conversion_rate: 0.02 });
    const drawn = traffic.rates(3, 1);
    expect(Math.abs(drawn.viewability - second.viewability)).toBeLessThan(0.7 * 0.05 * 6);
  });

  it('clips the truth deviation and the known part of the forecast', () => {
    const clip = 0.3;
    const base = 10_000;
    const traffic = new SeasonTraffic(synthSeed({
      base,
      error: { channel_sigma: { display: 0.4 }, cell_kappa: 4, log_clip: clip, publishers: [{ publisher_id: 'site_0', bias: -0.1 }] },
    }));
    let widestTruth = 0;
    let widestKnown = 0;
    for (const asOf of [0, 200, 700]) {
      for (let day = Math.max(asOf, 1); day < DAYS; day += 3) {
        for (let cell = 0; cell < traffic.slots.length; cell++) {
          widestTruth = Math.max(widestTruth, Math.abs(deviation(traffic, day, cell)));
          const bias = cell === 0 ? 0.1 : 0;
          widestKnown = Math.max(widestKnown, Math.abs(Math.log(traffic.forecastValue(day, cell, asOf) / base) - bias));
        }
      }
    }
    // The sigmas are large enough that both clips bind, so the bounds are not vacuous.
    expect(widestTruth).toBeLessThanOrEqual(clip + 1e-3);
    expect(widestTruth).toBeGreaterThan(clip - 1e-3);
    expect(widestKnown).toBeLessThanOrEqual(clip + 1e-9);
    expect(widestKnown).toBeGreaterThan(clip - 1e-9);
  });

  it('applies the deviation of a scheduled installment day on the day it runs, and none when cancelled', () => {
    const channelError = { channel_sigma: { display: 0.3, newsletter: 0.3 }, cell_kappa: 2, log_clip: 5 };
    const newsletter = (events: SeasonSeed['events']): SeasonSeed => {
      const base = synthSeed({ publishers: 1, error: channelError });
      return {
        ...base,
        properties: [{ property_id: 'letter', name: 'Letter', domain: 'letter.example' }],
        placements: [{
          placement_id: 'letter_slot',
          name: 'Letter slot',
          channel: 'newsletter',
          property_ids: ['letter'],
          formats: ['newsletter_native'],
          floor_cpm: 5,
          rates: { viewability: 0.7, click_rate: 0.01, completion_rate: 0, conversion_rate: 0.02 },
          reporting_lag_days: 0,
        }],
        collections: [{
          collection_id: 'letter',
          name: 'Letter',
          channel: 'newsletter',
          property_id: 'letter',
          placement_id: 'letter_slot',
          first_date: '2027-03-01',
          cadence_days: 7,
          count: 4,
          expected_audience: 1_000_000,
          audience_sigma: 0,
        }],
        events,
      };
    };
    const plain = new SeasonTraffic(newsletter([]));
    const postponed = new SeasonTraffic(newsletter([{ type: 'installment_postponed', event_id: 'moved', description: 'Moved', installment_id: 'letter_002', to_date: '2027-03-12' }]));
    const cancelled = new SeasonTraffic(newsletter([{ type: 'installment_cancelled', event_id: 'cut', description: 'Cut', installment_id: 'letter_002' }]));
    const scheduled = plain.calendar.dayOfDate('2027-03-08');
    const moved = plain.calendar.dayOfDate('2027-03-12');
    const cell = plain.slots.find(slot => slot.installment_id === 'letter_002')!.index;
    const length = audienceCurve('newsletter').length;
    let compared = 0;
    for (let k = 0; k < length; k++) {
      const onSchedule = plain.day(scheduled + k).actual.get(cell)!;
      expect(onSchedule).toBeGreaterThan(0);
      expect(postponed.day(moved + k).actual.get(cell)).toBe(onSchedule);
      expect(postponed.day(scheduled + k).actual.get(cell)).toBeUndefined();
      expect(cancelled.day(scheduled + k).actual.get(cell)).toBeUndefined();
      expect(cancelled.day(moved + k).actual.get(cell)).toBeUndefined();
      // The forecast stays on the scheduled days in all three worlds.
      expect(postponed.forecastValue(scheduled + k, cell, scheduled - 10)).toBe(plain.forecastValue(scheduled + k, cell, scheduled - 10));
      expect(cancelled.forecastValue(scheduled + k, cell, scheduled - 10)).toBe(plain.forecastValue(scheduled + k, cell, scheduled - 10));
      expect(deviation(plain, scheduled + k, cell)).not.toBe(0);
      compared += 1;
    }
    expect(compared).toBe(length);
  });

  it('keeps scripted events in the truth only', () => {
    const noisy = { channel_sigma: { display: 0.1 }, cell_kappa: 1 };
    const plain = new SeasonTraffic(synthSeed({ error: noisy, traffic: { truth_daily_sigma: 0.03 } }));
    const withEvent = new SeasonTraffic(synthSeed({
      error: noisy,
      traffic: { truth_daily_sigma: 0.03 },
      events: [{ type: 'traffic_multiplier', event_id: 'surge', description: 'Surge', start_date: '2027-03-01', end_date: '2027-03-10', multiplier: 3, property_ids: ['site_0'] }],
    }));
    const surgeDay = withEvent.calendar.dayOfDate('2027-03-05');
    for (const asOf of [0, surgeDay - 3, surgeDay]) {
      for (let day = 0; day < DAYS; day += 4) {
        for (let cell = 0; cell < plain.slots.length; cell++) {
          expect(withEvent.forecastValue(day, cell, asOf)).toBe(plain.forecastValue(day, cell, asOf));
        }
      }
    }
    expect(withEvent.day(surgeDay).actual.get(0)).toBeGreaterThan((plain.day(surgeDay).actual.get(0) ?? 0) * 2.9);
    expect(withEvent.day(surgeDay).actual.get(1)).toBe(plain.day(surgeDay).actual.get(1));

    const content = new SeasonTraffic(CONTENT_SEASON);
    const quiet = new SeasonTraffic({ ...CONTENT_SEASON, events: [] });
    const cancelled = content.slots.filter(slot => slot.installment_id === 'morning_brief_012').map(slot => slot.index);
    for (const asOf of [0, 11, 40]) {
      for (let day = 0; day < 120; day += 3) {
        for (let cell = 0; cell < content.slots.length; cell++) {
          expect(content.forecastValue(day, cell, asOf)).toBe(quiet.forecastValue(day, cell, asOf));
        }
      }
    }
    const actualOf = (traffic: SeasonTraffic) => cancelled.reduce((sum, cell) => {
      for (let day = 0; day < 120; day++) sum += traffic.day(day).actual.get(cell) ?? 0;
      return sum;
    }, 0);
    expect(actualOf(content)).toBe(0);
    expect(actualOf(quiet)).toBeGreaterThan(10_000);
  });

  describe('spikes', () => {
    const spikes = { per_publisher_min: 2, per_publisher_max: 2, size_min: 0.5, size_max: 1.5, decay: 0.9, decay_forecast_sigma: 0.3 };
    const rng = 'synth-v1';
    /** The spikes of a publisher, redrawn here from the model's keys. */
    const spikesOf = (publisher: string, config: typeof spikes) => [0, 1].map(i => ({
      day: Math.floor(uniform(`${rng}|spike-day|${publisher}|${i}`) * DAYS),
      size: config.size_min + uniform(`${rng}|spike-size|${publisher}|${i}`) * (config.size_max - config.size_min),
      estimated: config.decay ** Math.exp(config.decay_forecast_sigma * standardNormal(`${rng}|spike-decay-est|${publisher}|${i}`)),
    }));
    const tail = (list: ReturnType<typeof spikesOf>, day: number, asOf: number, decayOf: (spike: ReturnType<typeof spikesOf>[number]) => number) =>
      list.reduce((product, spike) => (spike.day <= Math.min(asOf, day) ? product * (1 + spike.size * decayOf(spike) ** (day - spike.day)) : product), 1);

    it('forecasts a spike only from the day it starts', () => {
      const without = new SeasonTraffic(synthSeed({ traffic: { truth_daily_sigma: 0.02 } }));
      const withSpikes = new SeasonTraffic(synthSeed({ traffic: { truth_daily_sigma: 0.02 }, error: { spikes } }));
      for (let cell = 0; cell < 20; cell++) {
        const list = spikesOf(`site_${cell}`, spikes);
        const first = Math.min(...list.map(spike => spike.day));
        for (let day = 0; day < DAYS; day += 5) {
          if (first > 0) expect(withSpikes.forecastValue(day, cell, first - 1)).toBe(without.forecastValue(day, cell, first - 1));
          for (const asOf of [first, first + 40, 900]) {
            if (asOf >= DAYS || day < asOf) continue;
            const ratio = withSpikes.forecastValue(day, cell, asOf) / without.forecastValue(day, cell, asOf);
            expect(ratio).toBeCloseTo(tail(list, day, asOf, spike => spike.estimated), 9);
          }
        }
      }
    });

    it('matches the true tail when the forecaster knows the decay', () => {
      const exact = { ...spikes, decay_forecast_sigma: 0 };
      const without = new SeasonTraffic(synthSeed());
      const withSpikes = new SeasonTraffic(synthSeed({ error: { spikes: exact } }));
      let compared = 0;
      for (let cell = 0; cell < 20; cell++) {
        const last = Math.max(...spikesOf(`site_${cell}`, exact).map(spike => spike.day));
        for (let day = last; day < Math.min(DAYS, last + 40); day++) {
          const forecastRatio = withSpikes.forecastValue(day, cell, last) / without.forecastValue(day, cell, last);
          const trueRatio = withSpikes.day(day).actual.get(cell)! / without.day(day).actual.get(cell)!;
          expect(forecastRatio).toBeCloseTo(trueRatio, 3);
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(400);
    });

    it('reports no tail spread before a spike starts and a positive one after', () => {
      const traffic = new SeasonTraffic(synthSeed({ error: { spikes } }));
      const first = Math.min(...spikesOf('site_0', spikes).map(spike => spike.day));
      expect(traffic.spikeTailSpread(first + 5, 0, Math.max(0, first - 1))).toBe(0);
      expect(traffic.spikeTailSpread(first + 5, 0, first)).toBeGreaterThan(0);
      expect(new SeasonTraffic(synthSeed()).spikeTailSpread(10, 0, 10)).toBe(0);
    });

    it('centres the tail spread on each spike own decay estimate', () => {
      const traffic = new SeasonTraffic(synthSeed({ error: { spikes } }));
      const list = spikesOf('site_0', spikes);
      const asOf = Math.max(...list.map(spike => spike.day));
      const day = Math.min(DAYS - 1, asOf + 10);
      const around = (sign: number) => Math.log(tail(list, day, asOf, spike => spike.estimated ** Math.exp(sign * spikes.decay_forecast_sigma)));
      expect(traffic.spikeTailSpread(day, 0, asOf)).toBeCloseTo(Math.abs(around(-1) - around(1)) / 2, 12);
    });

    it('ignores a spike that starts after the day when the as-of day is past it', () => {
      const without = new SeasonTraffic(synthSeed({ traffic: { truth_daily_sigma: 0.02 } }));
      const withSpikes = new SeasonTraffic(synthSeed({ traffic: { truth_daily_sigma: 0.02 }, error: { spikes } }));
      let checked = 0;
      for (let cell = 0; cell < 20; cell++) {
        for (const spike of spikesOf(`site_${cell}`, spikes)) {
          if (spike.day < 2) continue;
          const day = spike.day - 1;
          const others = spikesOf(`site_${cell}`, spikes).filter(other => other !== spike && other.day <= day);
          if (others.length > 0) continue;
          for (const asOf of [spike.day, Math.min(DAYS - 1, spike.day + 30)]) {
            expect(withSpikes.forecastValue(day, cell, asOf)).toBe(without.forecastValue(day, cell, asOf));
            checked += 1;
          }
        }
      }
      expect(checked).toBeGreaterThan(20);
    });
  });

  it('forecasts above the truth when the bias is negative', () => {
    const traffic = new SeasonTraffic(synthSeed({
      base: 1_000_000,
      error: { publishers: [{ publisher_id: 'site_0', bias: -0.02 }] },
    }));
    for (const [day, asOf] of [[100, 0], [100, 100], [700, 650]]) {
      expect(traffic.forecastValue(day, 0, asOf) / traffic.day(day).actual.get(0)!).toBeCloseTo(Math.exp(0.02), 5);
      expect(traffic.forecastValue(day, 1, asOf) / traffic.day(day).actual.get(1)!).toBeCloseTo(1, 5);
    }
  });

  it('puts the month of the year in expected traffic', () => {
    const month_shape = [1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const traffic = new SeasonTraffic(synthSeed({ traffic: { weekday_shape: [1, 2, 3, 4, 5, 6, 7], month_shape } }));
    const january = traffic.calendar.dayOfDate('2027-01-08');
    const february = traffic.calendar.dayOfDate('2027-02-05');
    expect(traffic.calendar.weekday(february)).toBe(traffic.calendar.weekday(january));
    expect(traffic.day(february).expected.get(0)).toBe(traffic.day(january).expected.get(0)! / 2);
    for (const asOf of [0, 20, february]) {
      expect(traffic.forecastValue(february, 0, asOf) / traffic.forecastValue(january, 0, asOf)).toBeCloseTo(0.5, 12);
    }
  });

  it('varies the truth day to day and leaves the forecast without the variation', () => {
    const traffic = new SeasonTraffic(synthSeed({ traffic: { truth_daily_sigma: 0.05 } }));
    const ratios: number[] = [];
    for (let cell = 0; cell < traffic.slots.length; cell++) {
      for (let day = 0; day < DAYS; day++) {
        const expected = traffic.day(day).expected.get(cell)!;
        ratios.push(traffic.day(day).actual.get(cell)! / expected);
        for (const asOf of [0, 500]) expect(traffic.forecastValue(day, cell, asOf)).toBe(expected);
      }
    }
    expect(sd(ratios)).toBeGreaterThan(0.04);
    expect(sd(ratios)).toBeLessThan(0.06);
  });

  it('refuses non-finite error values', () => {
    const cases: Array<[string, Partial<SeasonSeed['forecast_error']>, Partial<SeasonSeed['traffic']>]> = [
      ['channel_sigma', { channel_sigma: { display: Infinity } }, {}],
      ['cell_kappa', { cell_kappa: Infinity }, {}],
      ['log_clip', { log_clip: Infinity }, {}],
      ['lead_time_tau_days', { lead_time_tau_days: Infinity }, {}],
      ['cell_min_impressions', { cell_min_impressions: Infinity }, {}],
      ['truth_daily_sigma', {}, { truth_daily_sigma: Infinity }],
      ['month_shape', {}, { month_shape: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, Infinity] }],
      ['decay_forecast_sigma', { spikes: { per_publisher_min: 0, per_publisher_max: 1, size_min: 0, size_max: 1, decay: 0.5, decay_forecast_sigma: Infinity } }, {}],
      ['size_max', { spikes: { per_publisher_min: 0, per_publisher_max: 1, size_min: 0, size_max: Infinity, decay: 0.5, decay_forecast_sigma: 0 } }, {}],
      ['bias_sigma', { publishers: [{ publisher_id: 'site_0', bias: 0, bias_sigma: Infinity }] }, {}],
      ['error_scale', { publishers: [{ publisher_id: 'site_0', bias: 0, error_scale: Infinity }] }, {}],
    ];
    for (const [name, error, traffic] of cases) {
      expect(() => new SeasonTraffic(synthSeed({ error, traffic })), name).toThrow(EngineError);
    }
  });
});

describe('published range', () => {
  const DAY_MS = 86_400_000;
  const start = at('2027-01-01T00:00:00Z');
  const dayStart = (day: number) => start + day * DAY_MS;
  const noonOf = (day: number) => dayStart(day) + 12 * 3_600_000;
  const FLAT = [1, 1, 1, 1, 1, 1, 1];

  /** One display placement per publisher, one region and one profile, so cell `i` is publisher `i`
   * and expects `base` impressions every day; `prod_i` sells that cell alone. */
  function rangeSeed(options: { publishers?: number; days?: number; error?: Partial<SeasonSeed['forecast_error']>; traffic?: Partial<SeasonSeed['traffic']> } = {}): SeasonSeed {
    const { publishers = 1, days = 1100, error = {}, traffic = {} } = options;
    const ids = Array.from({ length: publishers }, (_, i) => `site_${i}`);
    return {
      seed_id: 'range',
      rng_seed: 'range-v1',
      start_date: '2027-01-01',
      days,
      currency: 'USD',
      regions: [{ region_id: 'r1', country: 'US', name: 'Region one', share: 1 }],
      audience_profiles: [{ profile_id: 'p1', name: 'Profile one', share: 1 }],
      segments: [],
      properties: ids.map(id => ({ property_id: id, name: id, domain: `${id}.example` })),
      placements: ids.map(id => ({
        placement_id: `pl_${id}`,
        name: id,
        channel: 'display' as const,
        property_ids: [id],
        formats: ['display_300x250'],
        base_daily_impressions: 10_000,
        floor_cpm: 1,
        rates: { viewability: 0.7, click_rate: 0.001, completion_rate: 0, conversion_rate: 0.02 },
        reporting_lag_days: 0,
      })),
      products: ids.map((id, i) => ({
        product_id: `prod_${i}`,
        name: id,
        description: id,
        delivery_type: 'guaranteed' as const,
        placement_ids: [`pl_${id}`],
        rate_cpm: 10,
      })),
      traffic: { weekday_shape: FLAT, ...traffic },
      forecast_error: {
        channel_sigma: { display: 0 },
        ar1_phi: 0.5,
        lead_time_tau_days: 14,
        lead_time_horizon_days: 60,
        log_clip: 50,
        cell_kappa: 0,
        cell_min_impressions: 100,
        ...error,
      },
    };
  }

  const flightOf = (first: number, last: number) => ({ flight_start_ms: dayStart(first), flight_end_ms: dayStart(last) });

  it('forecasts the same flight differently as the clock moves and narrows the range', () => {
    const sim = InventorySimulation.create(rangeSeed({ error: { channel_sigma: { display: 0.2 } } }), noonOf(0));
    const query = { product_id: 'prod_0', ...flightOf(20, 35) };
    const early = sim.forecast(query, noonOf(0));
    const later = sim.forecast(query, noonOf(7));
    expect(later.impressions).not.toBe(early.impressions);
    const width = (result: typeof early) => (result.high - result.low) / result.impressions;
    expect(width(early)).toBeGreaterThan(0);
    expect(width(later)).toBeLessThan(width(early));
  });

  it('gives the same forecast to two markets at the same simulated time', () => {
    const seed = rangeSeed({ publishers: 3, error: { channel_sigma: { display: 0.2 }, cell_kappa: 1 }, traffic: { truth_daily_sigma: 0.03 } });
    const walked = InventorySimulation.create(seed, noonOf(0));
    for (const day of [3, 9, 17]) walked.forecast({ product_id: 'prod_1', ...flightOf(day + 1, day + 20) }, noonOf(day));
    const fresh = InventorySimulation.create(seed, noonOf(17));
    for (const product_id of ['prod_0', 'prod_1', 'prod_2']) {
      const query = { product_id, ...flightOf(18, 60), budget: 4000 };
      expect(walked.forecast(query, noonOf(17))).toEqual(fresh.forecast(query, noonOf(17)));
    }
  });

  describe('closed form', () => {
    const PHI = 0.5;
    const SIGMA = 0.1;
    const KAPPA = 2;

    /** `Σ_i Σ_j v_i v_j φ^|i−j|`, by the definition. */
    const gram = (values: number[], phi: number) => {
      let sum = 0;
      for (let i = 0; i < values.length; i++) for (let j = 0; j < values.length; j++) sum += values[i] * values[j] * phi ** Math.abs(i - j);
      return sum;
    };
    const noRevisions = { channel_sigma: { display: SIGMA }, ar1_phi: PHI, lead_time_horizon_days: 0 };
    /** The forecast of each day of the cell, as known on `asOf`. */
    const forecasts = (sim: InventorySimulation, days: number[], asOf: number, cell = 0) => days.map(day => sim.traffic.forecastValue(day, cell, asOf));

    it('adds the same-day term of two days, less the part the closed days make known', () => {
      const sim = InventorySimulation.create(rangeSeed({ error: noRevisions }), noonOf(5));
      const days = [6, 7];
      const f = forecasts(sim, days, 5);
      const a = f.map(value => value * SIGMA);
      // A_t = F·σ. Leads h = 1 and 2, so the known part is A_6 φ² + A_7 φ³.
      const known = a[0] * PHI ** 2 + a[1] * PHI ** 3;
      const numerator = a[0] ** 2 + a[1] ** 2 + 2 * PHI * a[0] * a[1] - known ** 2;
      const result = sim.forecast({ product_id: 'prod_0', ...flightOf(6, 8) }, noonOf(5));
      expect(result.sigma ** 2).toBeCloseTo(numerator / (f[0] + f[1]) ** 2, 12);
    });

    it('adds the same-day term of three days with the AR correlation at every lag', () => {
      const sim = InventorySimulation.create(rangeSeed({ error: noRevisions }), noonOf(9));
      const days = [10, 11, 12];
      const f = forecasts(sim, days, 9);
      const a = f.map(value => value * SIGMA);
      const known = a.reduce((sum, value, i) => sum + value * PHI ** (i + 2), 0);
      const result = sim.forecast({ product_id: 'prod_0', ...flightOf(10, 13) }, noonOf(9));
      expect(result.sigma ** 2).toBeCloseTo((gram(a, PHI) - known ** 2) / f.reduce((x, y) => x + y, 0) ** 2, 12);
    });

    it('keeps the whole same-day term before any day has closed', () => {
      const sim = InventorySimulation.create(rangeSeed({ error: noRevisions }), noonOf(0));
      const f = forecasts(sim, [1, 2, 3], 0);
      const a = f.map(value => value * SIGMA);
      const result = sim.forecast({ product_id: 'prod_0', ...flightOf(1, 4) }, noonOf(0));
      expect(result.sigma ** 2).toBeCloseTo(gram(a, PHI) / f.reduce((x, y) => x + y, 0) ** 2, 12);
    });

    it('sums the cells of one publisher before squaring, each at its own channel sigma', () => {
      const base = rangeSeed({ error: { ...noRevisions, channel_sigma: { display: SIGMA, olv: 0.05 } } });
      const seed: SeasonSeed = {
        ...base,
        placements: [...base.placements, { ...base.placements[0], placement_id: 'pl_video', name: 'video', channel: 'olv' as const }],
        products: [{ product_id: 'both', name: 'both', description: 'both', delivery_type: 'guaranteed', placement_ids: ['pl_site_0', 'pl_video'], rate_cpm: 10 }],
      };
      const sim = InventorySimulation.create(seed, noonOf(5));
      const days = [6, 7, 8];
      const display = forecasts(sim, days, 5, 0);
      const video = forecasts(sim, days, 5, 1);
      expect(sim.traffic.publisherOf(0)).toBe(sim.traffic.publisherOf(1));
      // One publisher, so one shock per day: A_t = F_display·0.1 + F_video·0.05, summed before the products.
      const a = days.map((_, i) => display[i] * SIGMA + video[i] * 0.05);
      const known = a.reduce((sum, value, i) => sum + value * PHI ** (i + 2), 0);
      const weight = [...display, ...video].reduce((x, y) => x + y, 0);
      const result = sim.forecast({ product_id: 'both', ...flightOf(6, 9) }, noonOf(5));
      expect(result.sigma ** 2).toBeCloseTo((gram(a, PHI) - known ** 2) / weight ** 2, 12);
      // Treating the two cells as independent would drop the cross terms.
      const apart = (values: number[], sigma: number) => {
        const b = values.map(value => value * sigma);
        const k = b.reduce((sum, value, i) => sum + value * PHI ** (i + 2), 0);
        return gram(b, PHI) - k ** 2;
      };
      expect(result.sigma ** 2).toBeGreaterThan((apart(display, SIGMA) + apart(video, 0.05)) / weight ** 2 * 1.01);
    });

    it('adds the unrevealed revisions over the days each one reaches', () => {
      const horizon = 2;
      const error = { channel_sigma: { display: SIGMA }, ar1_phi: PHI, lead_time_horizon_days: horizon };
      // Revision r is revealed on day r and reaches the days r+1 to r+2. Seen on day 0 with a flight over
      // days 1 to 4, the revisions not yet revealed are r = 0..3: they reach [1,2], [2,3], [3,4] and [4].
      // Seen on day 2 with a flight over days 3 and 4, they are r = 2 and 3: [3,4] and [4].
      const cases: Array<{ asOf: number; days: number[]; windows: number[][] }> = [
        { asOf: 0, days: [1, 2, 3, 4], windows: [[1, 2], [2, 3], [3, 4], [4]] },
        { asOf: 2, days: [3, 4], windows: [[3, 4], [4]] },
      ];
      for (const { asOf, days, windows } of cases) {
        const sim = InventorySimulation.create(rangeSeed({ error }), noonOf(asOf));
        const f = forecasts(sim, days, asOf);
        const a = (day: number) => f[day - days[0]] * SIGMA;
        const all = days.map(a);
        const known = asOf >= 1 ? days.reduce((sum, day) => sum + a(day) * PHI ** (day - asOf + 1), 0) : 0;
        const sameDay = gram(all, PHI) - known ** 2;
        const revisions = windows.reduce((sum, window) => sum + gram(window.map(a), PHI), 0) / 14;
        const result = sim.forecast({ product_id: 'prod_0', ...flightOf(days[0], days[days.length - 1] + 1) }, noonOf(asOf));
        expect(result.sigma ** 2, `as of day ${asOf}`).toBeCloseTo((sameDay + revisions) / f.reduce((x, y) => x + y, 0) ** 2, 12);
      }
    });

    it('adds the publishers independently, each with its own same-day and revision terms', () => {
      const base = rangeSeed({ publishers: 2, error: noRevisions });
      const seed: SeasonSeed = {
        ...base,
        products: [{ product_id: 'both', name: 'both', description: 'both', delivery_type: 'guaranteed', placement_ids: ['pl_site_0', 'pl_site_1'], rate_cpm: 10 }],
      };
      const sim = InventorySimulation.create(seed, noonOf(5));
      const days = [6, 7, 8];
      let numerator = 0;
      let weight = 0;
      for (const cell of [0, 1]) {
        const f = forecasts(sim, days, 5, cell);
        const a = f.map(value => value * SIGMA);
        const known = a.reduce((sum, value, i) => sum + value * PHI ** (i + 2), 0);
        numerator += gram(a, PHI) - known ** 2;
        weight += f.reduce((x, y) => x + y, 0);
      }
      const result = sim.forecast({ product_id: 'both', ...flightOf(6, 9) }, noonOf(5));
      expect(result.sigma ** 2).toBeCloseTo(numerator / weight ** 2, 12);
    });

    it('adds the daily wobble of the truth once per placement and day, not across placements', () => {
      const WOBBLE = 0.04;
      const base = rangeSeed({ publishers: 2, traffic: { truth_daily_sigma: WOBBLE } });
      const seed: SeasonSeed = {
        ...base,
        products: [{ product_id: 'both', name: 'both', description: 'both', delivery_type: 'guaranteed', placement_ids: ['pl_site_0', 'pl_site_1'], rate_cpm: 10 }],
      };
      const sim = InventorySimulation.create(seed, noonOf(0));
      const days = [1, 2, 3];
      let numerator = 0;
      let weight = 0;
      for (const cell of [0, 1]) {
        for (const f of forecasts(sim, days, 0, cell)) {
          numerator += (f * WOBBLE) ** 2;
          weight += f;
        }
      }
      const result = sim.forecast({ product_id: 'both', ...flightOf(1, 4) }, noonOf(0));
      expect(result.sigma ** 2).toBeCloseTo(numerator / weight ** 2, 12);
    });

    it('shares the daily wobble across the cells of one placement', () => {
      const WOBBLE = 0.04;
      const seed = scarceSeed({ traffic: { weekday_shape: FLAT, truth_daily_sigma: WOBBLE }, events: [] });
      const sim = InventorySimulation.create(seed, noonOf(0));
      const cells = sim.traffic.eligibleCells('banner_guaranteed');
      expect(cells).toHaveLength(2);
      const days = [1, 2, 3];
      let numerator = 0;
      let weight = 0;
      for (const day of days) {
        const dayTotal = cells.reduce((sum, cell) => sum + sim.traffic.forecastValue(day, cell, 0), 0);
        numerator += (dayTotal * WOBBLE) ** 2;
        weight += dayTotal;
      }
      const result = sim.forecast({ product_id: 'banner_guaranteed', ...flightOf(1, 4) }, noonOf(0));
      expect(result.sigma ** 2).toBeCloseTo(numerator / weight ** 2, 12);
    });

    it('adds the cell term as independent per cell and day', () => {
      const sim = InventorySimulation.create(rangeSeed({ error: { cell_kappa: KAPPA } }), noonOf(0));
      const [f1, f2] = [1, 2].map(day => sim.traffic.forecastValue(day, 0, 0));
      const sigmaCell = KAPPA / Math.sqrt(10_000);
      const result = sim.forecast({ product_id: 'prod_0', ...flightOf(1, 3) }, noonOf(0));
      expect(result.sigma ** 2).toBeCloseTo((sigmaCell ** 2 * (f1 ** 2 + f2 ** 2)) / (f1 + f2) ** 2, 12);
    });

    it('floors the cell term at the minimum impressions', () => {
      const sim = InventorySimulation.create(rangeSeed({ error: { cell_kappa: KAPPA, cell_min_impressions: 40_000 } }), noonOf(0));
      const [f1, f2] = [1, 2].map(day => sim.traffic.forecastValue(day, 0, 0));
      const sigmaCell = KAPPA / Math.sqrt(40_000);
      const result = sim.forecast({ product_id: 'prod_0', ...flightOf(1, 3) }, noonOf(0));
      expect(result.sigma ** 2).toBeCloseTo((sigmaCell ** 2 * (f1 ** 2 + f2 ** 2)) / (f1 + f2) ** 2, 12);
    });

    it('adds the audience term per installment, fully correlated across its days', () => {
      const silent = Object.fromEntries(Object.keys(CONTENT_SEASON.forecast_error.channel_sigma).map(channel => [channel, 0]));
      const seed: SeasonSeed = {
        ...CONTENT_SEASON,
        traffic: { ...CONTENT_SEASON.traffic, truth_daily_sigma: 0 },
        forecast_error: { ...CONTENT_SEASON.forecast_error, channel_sigma: silent, cell_kappa: 0, log_clip: 50 },
      };
      const sim = InventorySimulation.create(seed, noonOf(0));
      const sigma = seed.collections!.find(collection => collection.collection_id === 'morning_brief')!.audience_sigma;
      const ids = ['morning_brief_011', 'morning_brief_013'];
      const [fa, fb] = ids.map(id => {
        let sum = 0;
        for (const cell of sim.traffic.eligibleCells('morning_brief_midroll', { installment_ids: [id] })) {
          for (let day = 1; day < 120; day++) sum += sim.traffic.forecastValue(day, cell, 0);
        }
        return sum;
      });
      const result = sim.forecast({ product_id: 'morning_brief_midroll', targeting: { installment_ids: ids }, ...flightOf(1, 120) }, noonOf(0));
      expect(result.sigma ** 2).toBeCloseTo((sigma ** 2 * (fa ** 2 + fb ** 2)) / (fa + fb) ** 2, 12);
    });
  });

  it('adds the spike term as one spread fully correlated across cells and days', () => {
    const rng = 'range-v1';
    const spikes = { per_publisher_min: 1, per_publisher_max: 1, size_min: 1, size_max: 1, decay: 0.95, decay_forecast_sigma: 0.5 };
    const base = rangeSeed({ publishers: 2, days: 60, error: { spikes } });
    const seed: SeasonSeed = {
      ...base,
      products: [{ product_id: 'both', name: 'both', description: 'both', delivery_type: 'guaranteed', placement_ids: ['pl_site_0', 'pl_site_1'], rate_cpm: 10 }],
    };
    const startDays = ['site_0', 'site_1'].map(id => Math.floor(uniform(`${rng}|spike-day|${id}|0`) * 60));
    const asOf = Math.max(...startDays);
    const sim = InventorySimulation.create(seed, noonOf(asOf));
    const days = [asOf + 1, asOf + 2];
    const spread = (day: number, cell: number) => sim.traffic.spikeTailSpread(day, cell, asOf);
    const forecast = (day: number, cell: number) => sim.traffic.forecastValue(day, cell, asOf);
    for (const day of days) for (const cell of [0, 1]) expect(spread(day, cell)).toBeGreaterThan(0);
    let numerator = 0;
    let total = 0;
    for (const day of days) for (const cell of [0, 1]) {
      numerator += forecast(day, cell) * spread(day, cell);
      total += forecast(day, cell);
    }
    const result = sim.forecast({ product_id: 'both', ...flightOf(asOf + 1, asOf + 3) }, noonOf(asOf));
    expect(result.sigma ** 2).toBeCloseTo(numerator ** 2 / total ** 2, 12);
  });

  it('covers the truth about 80% of the time', () => {
    const seed = rangeSeed({ publishers: 20, error: { channel_sigma: { display: 0.1 } } });
    const sim = InventorySimulation.create(seed, noonOf(0));
    let covered = 0;
    let samples = 0;
    for (let asOf = 0; asOf < 1000; asOf++) {
      const target = asOf + 7;
      const actuals = sim.traffic.day(target).actual;
      for (let cell = 0; cell < 20; cell++) {
        const result = sim.forecast({ product_id: `prod_${cell}`, ...flightOf(target, target + 1) }, noonOf(asOf));
        const actual = actuals.get(cell)!;
        if (actual >= result.low && actual <= result.high) covered++;
        samples++;
      }
    }
    const share = covered / samples;
    expect(share).toBeGreaterThan(0.75);
    expect(share).toBeLessThan(0.85);
  });

  it('caps the band at twice the clip', () => {
    const sim = InventorySimulation.create(rangeSeed({ error: { channel_sigma: { display: 3 }, lead_time_horizon_days: 365, log_clip: 0.5 } }), noonOf(0));
    const result = sim.forecast({ product_id: 'prod_0', ...flightOf(400, 401) }, noonOf(0));
    expect(1.2816 * result.sigma).toBeGreaterThan(1);
    // low, high and impressions are each rounded to whole impressions of about 10,000, so the ratio is good to 1e-4.
    expect(result.high / result.impressions).toBeLessThanOrEqual(Math.exp(1) * (1 + 1e-4));
    expect(result.high / result.impressions).toBeCloseTo(Math.exp(1), 3);
    expect(result.low / result.impressions).toBeCloseTo(Math.exp(-1), 3);
  });

  it('biases forecasts by the publisher bias', () => {
    const seed = rangeSeed({
      publishers: 5,
      error: { channel_sigma: { display: 0.05 }, publishers: Array.from({ length: 5 }, (_, i) => ({ publisher_id: `site_${i}`, bias: 0.1, bias_sigma: 0 })) },
      traffic: { truth_daily_sigma: 0.03 },
    });
    const traffic = new SeasonTraffic(seed);
    let sum = 0;
    let n = 0;
    for (let day = 7; day < seed.days; day++) {
      for (let cell = 0; cell < 5; cell++) {
        sum += Math.log(traffic.forecastValue(day, cell, day - 7) / traffic.day(day).actual.get(cell)!);
        n++;
      }
    }
    expect(Math.abs(sum / n + 0.1)).toBeLessThan(0.02);
  });

  it('nets guaranteed bookings out of the revised forecast', () => {
    const seed = rangeSeed({ days: 90, error: { channel_sigma: { display: 0.15 }, cell_kappa: 1 }, traffic: { truth_daily_sigma: 0.03 } });
    const sim = InventorySimulation.create(seed, noonOf(0));
    sim.book({ booking_id: 'g', product_id: 'prod_0', ...flightOf(1, 31), budget: 5000, impression_goal: 100_000 }, noonOf(0));
    for (const asOf of [0, 12]) {
      const result = sim.forecast({ product_id: 'prod_0', ...flightOf(1, 61), budget: 2500 }, noonOf(asOf));
      const affordable = 250_000;
      expect(Math.abs(result.available + result.booked - result.capacity)).toBeLessThanOrEqual(1);
      // The booking spreads what is left of its goal over its own serving days, [asOf, 31) because day
      // `asOf` has not run yet, in proportion to the forecast as known on `asOf`. A forecast starts
      // tomorrow, so it holds the days [asOf + 1, 31): the share of the days in that window.
      const left = 100_000 - sim.booking('g').delivered.impressions;
      let serving = 0;
      let inside = 0;
      for (let day = Math.max(asOf, 1); day < 31; day++) {
        const value = sim.traffic.forecastValue(day, 0, asOf);
        serving += value;
        if (day > asOf) inside += value;
      }
      expect(left).toBeLessThan(serving);
      expect(Math.abs(result.booked - (left * inside) / serving)).toBeLessThanOrEqual(1);
      expect(result.low).toBeLessThanOrEqual(result.impressions);
      expect(result.impressions).toBeLessThanOrEqual(result.high);
      expect(result.high).toBeLessThanOrEqual(affordable);
    }
  });

  it('scales share-of-voice reservations with the revised forecast', () => {
    const base = rangeSeed({ days: 90, error: { channel_sigma: { display: 0.15 }, cell_kappa: 1 }, traffic: { truth_daily_sigma: 0.03 } });
    const seed: SeasonSeed = {
      ...base,
      products: [...base.products, { product_id: 'sov', name: 'sov', description: 'sov', delivery_type: 'guaranteed', placement_ids: ['pl_site_0'], rate_cpm: 10, share_of_voice: 0.4 }],
    };
    const sim = InventorySimulation.create(seed, noonOf(0));
    sim.book({ booking_id: 's', product_id: 'sov', ...flightOf(1, 31), budget: 100_000 }, noonOf(0));
    const booked: number[] = [];
    for (const asOf of [0, 12]) {
      const result = sim.forecast({ product_id: 'prod_0', ...flightOf(1, 61) }, noonOf(asOf));
      let held = 0;
      for (let day = asOf + 1; day < 31; day++) held += 0.4 * sim.traffic.forecastValue(day, 0, asOf);
      expect(Math.abs(result.booked - held)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.available + result.booked - result.capacity)).toBeLessThanOrEqual(1);
      booked.push(result.booked);
    }
    expect(booked[1]).not.toBe(booked[0]);
  });
  describe('honest-seller miss rate', () => {
    const SEASON_START = at('2026-11-01T00:00:00Z');
    const dayOf = (day: number) => SEASON_START + day * DAY_MS;
    const AS_OF = 1;
    const LEAD = 30;
    const FLIGHT_DAYS = 30;
    const FIRST = AS_OF + LEAD;
    const LAST = FIRST + FLIGHT_DAYS;
    const SHORT = Math.log(0.9);

    /** The standard normal distribution function (Abramowitz and Stegun 7.1.26 complement, error below 1.5e-7). */
    const normalCdf = (x: number) => {
      const z = Math.abs(x) / Math.SQRT2;
      const t = 1 / (1 + 0.3275911 * z);
      const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
      return x >= 0 ? 1 - erfc / 2 : erfc / 2;
    };

    /**
     * The probability that a flight delivers under 90% of its forecast mid, for a seller who books the
     * whole forecast, to the second order. With `e_c` the unknown log error of a cell-day (mean 0,
     * variance `v_c`) and weights `w_c = F_c / W`, `ln(Σ w_c e^(e_c))` has mean `½(Σ w_c v_c − V)` and
     * variance `V`, where `V` is the published first-order variance; the publisher bias adds to the mean.
     * The first-order rate drops the `½(Σ w v − V)` shift. Both are returned.
     * The unknown part of a cell-day at lead `h` has
     * `v = a²·[(1 − φ^(2(h+1))) + min(h, H)/τ] + σ_cell² + σ_u²`.
     */
    function analyticMissRate(sim: InventorySimulation, seed: SeasonSeed, productId: string, bias: number): { first: number; second: number } {
      const { traffic } = sim;
      const error = seed.forecast_error;
      const wobble = seed.traffic.truth_daily_sigma ?? 0;
      let weight = 0;
      let weighted = 0;
      for (const cell of traffic.eligibleCells(productId)) {
        for (let day = FIRST; day < LAST; day++) {
          const lead = day - AS_OF;
          const a = traffic.publisherScale(cell);
          const v = a * a * ((1 - error.ar1_phi ** (2 * (lead + 1))) + Math.min(lead, error.lead_time_horizon_days) / error.lead_time_tau_days)
            + traffic.cellSigma(day, cell) ** 2 + wobble ** 2;
          const value = traffic.forecastValue(day, cell, AS_OF);
          weight += value;
          weighted += value * v;
        }
      }
      const { sigma } = sim.forecast({ product_id: productId, flight_start_ms: dayOf(FIRST), flight_end_ms: dayOf(LAST) }, dayOf(AS_OF) + 12 * 3_600_000);
      const variance = sigma ** 2;
      const mean = bias + 0.5 * (weighted / weight - variance);
      return { first: normalCdf((SHORT - bias) / sigma), second: normalCdf((SHORT - mean) / sigma) };
    }

    it('has a seller booking the forecast on a single-publisher product fall short of 90% in 5-11% of 30-day flights booked 30 days ahead (traffic against forecast)', () => {
      const sim = InventorySimulation.create(ADSERVER_SEASON, dayOf(AS_OF) + 12 * 3_600_000);
      // The flight (2026-12-02 to 2026-12-31) holds none of the scripted events. sports_hero_guaranteed is one
      // publisher, Summit Sports, whose bias is -0.02.
      const bias = ADSERVER_SEASON.forecast_error.publishers!.find(entry => entry.publisher_id === 'summit_sports')!.bias;
      expect(bias).toBe(-0.02);
      const rate = analyticMissRate(sim, ADSERVER_SEASON, 'sports_hero_guaranteed', bias).second;
      expect(rate).toBeGreaterThan(0.05);
      expect(rate).toBeLessThan(0.11);
    });

    it('realises the second-order miss rate, not the first-order one, over many independent publishers with hero-sized cells', () => {
      const PUBLISHERS = 250;
      const CHUNKS = 16;
      const error = ADSERVER_SEASON.forecast_error;
      const ids = Array.from({ length: PUBLISHERS }, (_, i) => `site_${i}`);
      const seedOf = (chunk: number): SeasonSeed => ({
        seed_id: 'miss-rate',
        rng_seed: `miss-rate-${chunk}`,
        start_date: ADSERVER_SEASON.start_date,
        days: 80,
        currency: 'USD',
        regions: [{ region_id: 'r1', country: 'US', name: 'Region one', share: 1 }],
        audience_profiles: [{ profile_id: 'p1', name: 'Profile one', share: 1 }],
        segments: [],
        properties: ids.map(id => ({ property_id: id, name: id, domain: `${id}.example` })),
        placements: ids.map(id => ({
          placement_id: `pl_${id}`,
          name: id,
          channel: 'display' as const,
          property_ids: [id],
          formats: ['display_300x250'],
          base_daily_impressions: 400,
          floor_cpm: 1,
          rates: { viewability: 0.7, click_rate: 0.001, completion_rate: 0, conversion_rate: 0.02 },
          reporting_lag_days: 0,
        })),
        products: ids.map((id, i) => ({ product_id: `prod_${i}`, name: id, description: id, delivery_type: 'guaranteed' as const, placement_ids: [`pl_${id}`], rate_cpm: 10 })),
        traffic: { weekday_shape: FLAT, truth_daily_sigma: ADSERVER_SEASON.traffic.truth_daily_sigma },
        forecast_error: { ...error, publishers: ids.map(publisher_id => ({ publisher_id, bias: -0.02 })) },
      });
      let missed = 0;
      let samples = 0;
      let analytic = 0;
      let firstOrder = 0;
      for (let chunk = 0; chunk < CHUNKS; chunk++) {
        const seed = seedOf(chunk);
        const sim = InventorySimulation.create(seed, dayOf(AS_OF) + 12 * 3_600_000);
        for (let i = 0; i < PUBLISHERS; i++) {
          let actual = 0;
          let forecast = 0;
          for (let day = FIRST; day < LAST; day++) {
            actual += sim.traffic.day(day).actual.get(i) ?? 0;
            forecast += sim.traffic.forecastValue(day, i, AS_OF);
          }
          if (actual < 0.9 * forecast) missed++;
          const rate = analyticMissRate(sim, seed, `prod_${i}`, -0.02);
          analytic += rate.second;
          firstOrder += rate.first;
          samples++;
        }
      }
      const expected = analytic / samples;
      const naive = firstOrder / samples;
      // Cells of 400 impressions a day, the size of the shipped hero unit's cells, put the second-order shift
      // well away from zero: the first-order rate is about 12.6% against about 8.5% second order. The realised
      // count is binomial over independent publishers, so its share has a standard deviation of
      // sqrt(p(1 - p) / n); four of them is the tolerance. Re-seeded seasons of the shipped ad server (20,000)
      // realised 7.63% +- 0.19% against an analytic 7.57%, so the third-order terms stay inside it.
      const tolerance = 4 * Math.sqrt((expected * (1 - expected)) / samples);
      expect(Math.abs(naive - expected)).toBeGreaterThan(tolerance);
      expect(Math.abs(missed / samples - expected)).toBeLessThan(tolerance);
      expect(Math.abs(missed / samples - naive)).toBeGreaterThan(tolerance);
    });
  });
});

describe('engine version', () => {
  /** Rounds to 9 significant digits so platforms with different libm results agree. */
  const round = (value: number) => Number(value.toPrecision(9));

  /** Hash of everything the engine computes for a fixed call script on a season. */
  function outputHash(seed: SeasonSeed, productIds: readonly string[], bookings: readonly { id: string; product: string; budget: number; goal?: number; bid?: number }[]): string {
    const now = at('2026-11-10T12:00:00Z');
    const sim = InventorySimulation.create(seed, now);
    const firstDay = sim.state.processed_through_day;
    for (const booking of bookings) {
      sim.book({
        booking_id: booking.id,
        product_id: booking.product,
        flight_start_ms: at('2026-11-12'),
        flight_end_ms: at('2026-12-30'),
        budget: booking.budget,
        ...(booking.goal !== undefined ? { impression_goal: booking.goal } : {}),
        ...(booking.bid !== undefined ? { bid_cpm: booking.bid } : {}),
      }, now);
    }
    const later = now + 40 * 86_400_000;
    sim.advanceTo(later);

    let booked = 0;
    const forecasts = productIds.flatMap(product => {
      const flight = { flight_start_ms: at('2027-01-05'), flight_end_ms: at('2027-02-04') };
      const row = (label: string, result: ReturnType<typeof sim.forecast>) => [
        label,
        round(result.available), round(result.low), round(result.high), round(result.sigma),
        round(result.capacity), round(result.booked), round(result.impressions), round(result.clicks),
        round(result.viewable_impressions), round(result.completed_views), round(result.conversions), round(result.spend),
      ];
      const bid = seed.products.find(candidate => candidate.product_id === product)!.delivery_type === 'guaranteed' ? {} : { bid_cpm: 3.5 };
      const open = sim.forecast({ product_id: product, ...flight, ...bid }, later);
      // A budget a tenth of what the open forecast would spend caps impressions, low and high.
      const capped = sim.forecast({ product_id: product, ...flight, budget: Math.max(1, open.spend / 10), ...bid }, later);
      expect(capped.impressions).toBeLessThan(open.impressions);
      // A window inside the bookings' flights, so the reservations they hold are netted out of it.
      const inFlight = sim.forecast({
        product_id: product,
        flight_start_ms: later + 86_400_000,
        flight_end_ms: at('2026-12-30'),
        ...bid,
      }, later);
      booked += inFlight.booked;
      return [row(product, open), row(`${product}:capped`, capped), row(`${product}:in-flight`, inFlight)];
    });
    expect(booked).toBeGreaterThan(0);
    const tables = [];
    for (let day = firstDay; day < firstDay + 40; day += 1) {
      const actual = [...sim.traffic.day(day).actual.entries()].sort((a, b) => a[0] - b[0]);
      tables.push([day, actual.map(([cell, count]) => [cell, round(count)])]);
    }
    const delivery = bookings.map(booking => {
      const totals = sim.delivery(booking.id, later + 10 * 86_400_000).totals;
      return [
        booking.id,
        round(totals.impressions), round(totals.spend), round(totals.clicks),
        round(totals.viewable_impressions), round(totals.completed_views), round(totals.conversions),
      ];
    });
    return createHash('sha256').update(JSON.stringify({ forecasts, tables, delivery })).digest('hex');
  }

  it('pins the engine outputs to the engine version', () => {
    // A change that moves either hash must bump ENGINE_VERSION and update all three literals.
    expect(ENGINE_VERSION).toBe('2');
    const adserver = outputHash(
      ADSERVER_SEASON,
      ADSERVER_SEASON.products.map(product => product.product_id),
      [
        { id: 'g', product: 'ros_display_guaranteed', budget: 50_000, goal: 3_000_000 },
        { id: 'n', product: 'ros_display_auction', budget: 20_000, bid: 3.5 },
      ],
    );
    const content = outputHash(
      CONTENT_SEASON,
      CONTENT_SEASON.products.map(product => product.product_id),
      [
        { id: 'a', product: 'morning_brief_midroll', budget: 20_000 },
        { id: 'b', product: 'weekly_dispatch_sponsor', budget: 15_000 },
      ],
    );
    expect(adserver).toBe('7aeb9a70a5cfba64cb83ec4cf5df95d6de2081f8dc2e7ca41fce119b3538a243');
    expect(content).toBe('8159d846249783f49037f8b1e623f8366cea273ec47d1a61c68cc01f51105331');
  });
});
