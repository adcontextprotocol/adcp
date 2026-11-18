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
