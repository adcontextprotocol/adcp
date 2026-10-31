'use strict';

/**
 * Property tests for the reporting-subscription coverage reference model
 * (scripts/reference/reporting-coverage) and its calendar, over seeded random
 * inputs. fast-check is not a devDependency of this repository, so the inputs
 * come from a small seeded generator: every run sees the same cases, and a
 * failure names its seed so it can be replayed alone.
 *
 * Properties, from core/reporting-subscription.json x-adcp-validation and
 * core/reporting-schedule.json period_generation:
 *   - exceptions only remove periods;
 *   - nothing is owed twice, across versions, cutovers, and grants;
 *   - the cutover stretch owed under neither schedule is shorter than one
 *     incoming period, and empty when the schedules share boundaries;
 *   - the owed set is prefix-stable as now advances;
 *   - an extension never makes an elapsed period owed;
 *   - backfill and earlier confirmation only add periods;
 *   - calendar invariants: tiling, local midnights, wall-clock multiples,
 *     month-end clamping, and the 1970 origins.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const REFERENCE = path.resolve(__dirname, '../scripts/reference/reporting-coverage');
const { expectedSubscriptionPeriods, format } = require(path.join(REFERENCE, 'coverage.cjs'));
const { utcCalendar, localCalendar, billingCalendar } = require(path.join(REFERENCE, 'calendar.cjs'));
const tz = require(path.join(REFERENCE, 'tz.cjs'));

const HOUR = 3_600_000;
const DAY = tz.DAY;
const RUNS = 120;

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

/** mulberry32: a small, well-distributed 32-bit PRNG. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: list => list[Math.floor(next() * list.length)],
    bool: (p = 0.5) => next() < p,
  };
}

/** Run a property over RUNS seeds, naming the seed on failure. */
function forAll(name, property, runs = RUNS) {
  test(name, () => {
    for (let seed = 1; seed <= runs; seed += 1) {
      try {
        property(rng(seed * 7919 + name.length), seed);
      } catch (error) {
        error.message = `[seed ${seed}] ${error.message}`;
        throw error;
      }
    }
  });
}

const ZONES = ['America/New_York', 'America/Santiago', 'America/Havana', 'Africa/Cairo', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Asia/Tokyo'];
// Midnight never moves for these, so day boundaries are also hour boundaries.
const ZONES_WITHOUT_MIDNIGHT_TRANSITIONS = ['America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Asia/Tokyo'];
const PROFILE = {
  id: 'adcp.delivery.v1', version: '1.0.0', schema_uri: 'https://seller.example/schemas/delivery.json',
  schema_sha256: 'a'.repeat(64), schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only', grain: 'daily', primary_keys: ['account_id', 'package_id'],
};

function offering(id, duration, alignment, dims = ['package']) {
  return {
    offering_id: id, feed_purpose: 'analytics', report_definition_id: `rd_${id}`,
    report_definition_uri: `https://seller.example/report-definitions/${id}.json`, report_definition_sha256: 'b'.repeat(64),
    reporting_profile: PROFILE, schedule: { period_duration: duration, alignment, delivery_sla: 'PT6H' },
    supported_finality: ['official'], reconciliation_mode: 'delivery_only', standard_dimensions: dims,
  };
}

const iso = ms => format(ms);

/**
 * A random subscription over about three weeks of one account: up to three
 * versions (each choosing alignment and match), an optional inactive interval,
 * up to three grants, up to three buys with random flights, and optional
 * account timezone change.
 */
function randomCase(r, { allowAll = true, inactive = true } = {}) {
  const t0 = Date.UTC(2026, r.int(0, 11), r.int(1, 25));
  // A random instant lo..hi days from t0, on a quarter hour, sometimes nudged off it.
  const at = (lo, hi) => t0 + r.int(lo * 96, hi * 96) * (HOUR / 4) + r.pick([0, 0, 1, 30 * 60_000]);
  const duration = r.pick(['P1D', 'P1D', 'PT6H', 'PT1H']);
  const offerings = [
    offering('off_a_utc', duration, 'utc'),
    offering('off_b_local', duration, 'account_timezone'),
    offering('off_c_local_creative', duration, 'account_timezone', ['package', 'creative']),
  ];
  const versionCount = r.int(1, 3);
  const versions = [];
  let accepted = at(-2, 2);
  for (let v = 1; v <= versionCount; v += 1) {
    const selector = { feed_purpose: 'analytics', period_duration: duration, required_finality: 'official', dimensions: ['package'] };
    const alignment = r.pick([undefined, 'utc', 'account_timezone']);
    if (alignment) selector.alignment = alignment;
    selector.match = r.pick(allowAll ? ['exact', 'finest', 'all'] : ['exact', 'finest']);
    versions.push({
      subscription_version: v,
      accepted_at: iso(accepted),
      configuration: { subscription_id: 'sub', subscription_version: v, active: true, scope: { all_authorized_accounts: true }, selector, reconciliation_mode: 'delivery_only' },
    });
    accepted += r.int(1, 6 * 24) * HOUR + r.pick([0, 15 * 60_000]);
  }
  const grants = [{ authorized_at: iso(at(-10, 4)) }];
  if (r.bool(0.4)) {
    let cursor = Date.parse(grants[0].authorized_at);
    for (let g = 0; g < r.int(1, 2); g += 1) {
      const revoked = cursor + r.int(24, 8 * 24) * HOUR;
      grants[grants.length - 1].unauthorized_at = iso(revoked);
      cursor = revoked + r.int(1, 4 * 24) * HOUR;
      grants.push({ authorized_at: iso(cursor) });
    }
  }
  const buys = [];
  for (let b = 0; b < r.int(1, 3); b += 1) {
    const start = at(-3, 10);
    const buy = {
      media_buy_id: `mb_${b}`,
      confirmed_at: r.bool(0.9) ? iso(start + r.int(-72, 24) * HOUR) : null,
      start_time: iso(start),
      end_time: iso(start + r.int(0, 10 * 24) * HOUR),
      packages: [{ package_id: 'pkg_1', reporting_delivery_offering_ids: offerings.map(o => o.offering_id) }],
    };
    if (r.bool(0.2)) buy.canceled_at = iso(start + r.int(-24, 5 * 24) * HOUR);
    buys.push(buy);
  }
  const input = {
    subscription_id: 'sub',
    versions,
    account: { account_id: 'acct_1', timezone: r.pick(ZONES), grants },
    buys,
    offerings,
    status_retention_days: r.int(1, 4),
    now: iso(at(8, 28)),
  };
  if (inactive && r.bool(0.3)) {
    const from = at(0, 12);
    input.inactive_intervals = [{ deactivated_at: iso(from), ...(r.bool(0.7) ? { reactivated_at: iso(from + r.int(1, 5 * 24) * HOUR) } : {}) }];
  }
  if (r.bool(0.2)) input.backfill_on_regrant = true;
  return input;
}

const owedKeys = result => result.expected.map(row => JSON.stringify(row));
const run = input => expectedSubscriptionPeriods(input);

// ---------------------------------------------------------------------------
// Coverage properties
// ---------------------------------------------------------------------------

forAll('exceptions only remove periods', r => {
  const input = randomCase(r);
  const before = new Set(owedKeys(run(input)));
  const from = Date.parse(input.versions[0].accepted_at) + r.int(-48, 20 * 24) * HOUR;
  const entry = r.pick([
    { reason: 'capacity', from: iso(from), ...(r.bool() ? { until: iso(from + r.int(1, 5 * 24) * HOUR) } : {}) },
    { reason: 'offering_unsupported', media_buy_id: 'mb_0', from: iso(from) },
    { reason: 'capacity', offering_id: 'off_b_local', from: iso(from), until: iso(from + r.int(1, 5 * 24) * HOUR) },
  ]);
  const withException = { ...input, coverage: r.bool() ? { excluded: [entry] } : { gaps: [{ from: entry.from, until: iso(from + DAY), reason: 'unauthorized' }] } };
  for (const key of owedKeys(run(withException))) assert.ok(before.has(key), `an exception added ${key}`);
});

forAll('nothing is owed twice across versions, cutovers, and grants', r => {
  const input = randomCase(r);
  const byBuyAndOffering = new Map();
  for (const row of run(input).expected) {
    const key = `${row.media_buy_id}|${row.offering_id}`;
    if (!byBuyAndOffering.has(key)) byBuyAndOffering.set(key, []);
    byBuyAndOffering.get(key).push([Date.parse(row.period_start), Date.parse(row.period_end), row.subscription_version]);
  }
  for (const [key, periods] of byBuyAndOffering) {
    periods.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < periods.length; i += 1) {
      assert.ok(periods[i][0] >= periods[i - 1][1], `${key}: v${periods[i - 1][2]} and v${periods[i][2]} overlap at ${iso(periods[i][0])}`);
    }
  }
});

forAll('with one offering per side, a buy is never owed overlapping periods', r => {
  // exact and finest resolve one offering per package; across a resolution change the incoming offering
  // starts at the latest outgoing end, so even different offerings never overlap in time. Inactive
  // intervals are left out: reactivation is a fresh start at the first boundary at or after the
  // reactivation instant, not a cutover, so after a schedule change made while inactive its first
  // period can overlap the last one owed before the deactivation.
  const input = randomCase(r, { allowAll: false, inactive: false });
  const byBuy = new Map();
  for (const row of run(input).expected) {
    if (!byBuy.has(row.media_buy_id)) byBuy.set(row.media_buy_id, []);
    byBuy.get(row.media_buy_id).push([Date.parse(row.period_start), Date.parse(row.period_end), row.offering_id]);
  }
  for (const [buy, periods] of byBuy) {
    periods.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < periods.length; i += 1) {
      assert.ok(periods[i][0] >= periods[i - 1][1], `${buy}: ${periods[i - 1][2]} and ${periods[i][2]} overlap at ${iso(periods[i][0])}`);
    }
  }
});

forAll('the owed set is prefix-stable as now advances', r => {
  const input = randomCase(r);
  const later = Date.parse(input.now) + r.int(1, 10 * 24) * HOUR;
  const now = Date.parse(input.now);
  const early = owedKeys(run(input));
  const prefix = run({ ...input, now: iso(later) }).expected.filter(row => Date.parse(row.period_end) <= now).map(row => JSON.stringify(row));
  assert.deepEqual(early, prefix);
});

forAll('an extension never makes an elapsed period owed', r => {
  const input = randomCase(r);
  const buy = input.buys[0];
  const replacedAt = Date.parse(buy.start_time) + r.int(-24, 8 * 24) * HOUR;
  const extended = structuredClone(input);
  extended.buys[0] = {
    ...buy,
    end_time: iso(Date.parse(buy.end_time) + r.int(1, 6 * 24) * HOUR),
    prior_flights: [{ replaced_at: iso(replacedAt), start_time: buy.start_time, end_time: buy.end_time, ...(buy.canceled_at ? { canceled_at: buy.canceled_at } : {}) }],
  };
  delete extended.buys[0].canceled_at;
  const resolvedBefore = rows => rows.filter(row => Date.parse(row.period_end) < replacedAt).map(row => JSON.stringify(row));
  assert.deepEqual(resolvedBefore(run(extended).expected), resolvedBefore(run(input).expected));
});

forAll('backfill on re-grant only adds periods', r => {
  const input = randomCase(r);
  const without = new Set(owedKeys(run({ ...input, backfill_on_regrant: false })));
  const withBackfill = new Set(owedKeys(run({ ...input, backfill_on_regrant: true })));
  for (const key of without) assert.ok(withBackfill.has(key), `backfill removed ${key}`);
});

forAll('confirming earlier never owes less', r => {
  const input = randomCase(r);
  const earlier = structuredClone(input);
  for (const buy of earlier.buys) if (buy.confirmed_at) buy.confirmed_at = iso(Date.parse(buy.confirmed_at) - r.int(1, 72) * HOUR);
  const later = new Set(owedKeys(run(input)));
  const sooner = new Set(owedKeys(run(earlier)));
  for (const key of later) assert.ok(sooner.has(key), `earlier confirmation removed ${key}`);
});

// ---------------------------------------------------------------------------
// Cutover geometry (cutover: "it is shorter than one incoming period and is empty when both schedules
// share boundaries (same alignment and timezone, nested durations)")
// ---------------------------------------------------------------------------

function randomSchedule(r, zone) {
  return r.pick([
    () => utcCalendar(r.pick(['P1D', 'PT1H', 'PT6H', 'PT7H', 'P7D'])),
    () => localCalendar(r.pick(['P1D', 'PT1H', 'PT30M', 'PT4H', 'P7D', 'P1M']), zone),
    () => billingCalendar(r.pick(['P1M', 'P3M']), zone, Date.UTC(2025, r.int(0, 11), r.int(1, 31) > 28 ? 31 : r.int(1, 28), r.int(0, 23))),
  ])();
}

function containing(periods, t) {
  return periods.find(p => p.start <= t && t < p.end);
}

forAll('the cutover stretch is shorter than one incoming period', r => {
  const zone = r.pick(ZONES);
  const outgoing = randomSchedule(r, zone);
  const incoming = randomSchedule(r, r.bool() ? zone : r.pick(ZONES));
  const T = Date.UTC(2026, r.int(0, 11), r.int(1, 28)) + r.int(0, 24 * 60) * 60_000;
  const lo = T - 200 * DAY;
  const hi = T + 200 * DAY;
  const out = outgoing.periods(lo, hi);
  const E = Math.max(...out.filter(p => p.start < T).map(p => p.end));
  assert.ok(E >= T && (E === T || E - T < containing(out, T).end - containing(out, T).start), 'E is within one outgoing period of T');
  const inc = incoming.periods(lo, hi).filter(p => p.end > p.start);
  const first = inc.find(p => p.start >= E);
  const around = containing(inc, E);
  if (around.start === E) assert.equal(first.start, E);
  else assert.ok(first.start - E < around.end - around.start, `stretch ${iso(E)}..${iso(first.start)} is not shorter than ${iso(around.start)}..${iso(around.end)}`);
});

forAll('the stretch is empty when the incoming duration divides the outgoing one in the same zone', r => {
  // The incoming boundaries then include every outgoing boundary, so E is an incoming boundary.
  const zone = r.pick(ZONES_WITHOUT_MIDNIGHT_TRANSITIONS);
  const [coarse, fine] = r.pick([['P1D', 'PT1H'], ['P1D', 'PT30M'], ['PT6H', 'PT1H'], ['P1M', 'P1D'], ['P7D', 'P1D'], ['P1D', 'PT4H'], ['P1Y', 'P1M']]);
  const T = Date.UTC(2026, r.int(0, 11), r.int(1, 28)) + r.int(0, 24 * 60) * 60_000;
  const window = [T - 400 * DAY, T + 400 * DAY];
  const outgoing = localCalendar(coarse, zone).periods(...window);
  const E = Math.max(...outgoing.filter(p => p.start < T).map(p => p.end));
  const incoming = new Set(localCalendar(fine, zone).periods(...window).map(p => p.start));
  assert.ok(incoming.has(E), `${coarse} -> ${fine} in ${zone}: E ${iso(E)} is not an incoming boundary`);
});

// ---------------------------------------------------------------------------
// Calendar invariants (period_generation)
// ---------------------------------------------------------------------------

const timeOfDay = (zone, t) => ((tz.toWall(zone, t) % DAY) + DAY) % DAY;

forAll('periods tile: each end is the next start and boundaries never go backwards', r => {
  const zone = r.pick([...ZONES, 'Pacific/Apia']);
  const calendar = randomSchedule(r, zone);
  const center = Date.UTC(r.pick([2011, 2025, 2026]), r.int(0, 11), r.int(1, 28));
  const periods = calendar.periods(center - 60 * DAY, center + 60 * DAY);
  for (let i = 1; i < periods.length; i += 1) {
    assert.equal(periods[i].start, periods[i - 1].end);
    assert.ok(periods[i].end >= periods[i].start);
  }
});

forAll('utc P1D and PT24H are the same 24-hour days, and P7D weeks start on Thursday', r => {
  const center = Date.UTC(2026, r.int(0, 11), r.int(1, 28));
  const days = utcCalendar('P1D').periods(center - 30 * DAY, center + 30 * DAY);
  assert.deepEqual(utcCalendar('PT24H').periods(center - 30 * DAY, center + 30 * DAY), days);
  for (const p of days) assert.equal(p.end - p.start, DAY);
  for (const p of utcCalendar('P7D').periods(center - 60 * DAY, center + 60 * DAY)) assert.equal(new Date(p.start).getUTCDay(), 4);
});

forAll('local P1D boundaries are local midnights, or the first instant after a gap over midnight', r => {
  const zone = r.pick([...ZONES, 'Pacific/Apia']);
  const center = Date.UTC(r.pick([2011, 2025, 2026]), r.int(0, 11), r.int(1, 28));
  for (const p of localCalendar('P1D', zone).periods(center - 60 * DAY, center + 60 * DAY)) {
    const midnight = timeOfDay(zone, p.start) === 0;
    const afterGap = tz.offsetAt(zone, p.start - 1) < tz.offsetAt(zone, p.start);
    assert.ok(midnight || afterGap, `${zone} ${iso(p.start)}`);
    if (midnight) assert.equal(tz.wallInstants(zone, tz.toWall(zone, p.start))[0], p.start, `${zone} ${iso(p.start)} is the earlier of a repeated midnight`);
  }
});

forAll('local sub-daily boundaries are exactly the instants on a whole multiple of the duration', r => {
  const zone = r.pick(ZONES);
  const duration = r.pick(['PT1H', 'PT30M', 'PT2H', 'PT3H', 'PT15M']);
  const step = { PT1H: HOUR, PT30M: HOUR / 2, PT2H: 2 * HOUR, PT3H: 3 * HOUR, PT15M: HOUR / 4 }[duration];
  // Around a transition when the zone has them.
  const transitions = tz.transitions(zone).filter(t => t.at > Date.UTC(2025, 0, 1) && t.at < Date.UTC(2027, 0, 1));
  const center = transitions.length ? r.pick(transitions).at : Date.UTC(2026, r.int(0, 11), r.int(1, 28));
  const lo = center - 2 * DAY;
  const hi = center + 2 * DAY;
  const boundaries = new Set(localCalendar(duration, zone).periods(lo, hi).map(p => p.start));
  for (let t = lo; t < hi; t += 15 * 60_000) {
    assert.equal(boundaries.has(t), timeOfDay(zone, t) % step === 0, `${zone} ${duration} at ${iso(t)}`);
  }
});

forAll('local hourly periods per local day equal the whole hours that exist on it', r => {
  const zone = r.pick(ZONES_WITHOUT_MIDNIGHT_TRANSITIONS);
  const transitions = tz.transitions(zone).filter(t => t.at > Date.UTC(2025, 0, 1) && t.at < Date.UTC(2027, 0, 1));
  const center = transitions.length ? r.pick(transitions).at : Date.UTC(2026, r.int(0, 11), r.int(1, 28));
  const days = localCalendar('P1D', zone).periods(center - 3 * DAY, center + 3 * DAY);
  const hours = localCalendar('PT1H', zone).periods(center - 4 * DAY, center + 4 * DAY);
  for (const day of days.slice(1, -1)) {
    const inside = hours.filter(h => h.start >= day.start && h.start < day.end);
    let existing = 0;
    const wallDay = tz.toWall(zone, day.start);
    for (let h = 0; h < 24; h += 1) existing += tz.wallInstants(zone, wallDay + h * HOUR).length;
    assert.equal(inside.length, existing, `${zone} ${iso(day.start)}`);
  }
});

forAll('local PT24H equals P1D where midnight never moves', r => {
  const zone = r.pick(ZONES_WITHOUT_MIDNIGHT_TRANSITIONS);
  const center = Date.UTC(2026, r.int(0, 11), r.int(1, 28));
  assert.deepEqual(localCalendar('PT24H', zone).periods(center - 40 * DAY, center + 40 * DAY), localCalendar('P1D', zone).periods(center - 40 * DAY, center + 40 * DAY));
});

forAll('month boundaries keep the anchor day, clamped to the month end', r => {
  const zone = r.pick(['UTC', 'America/New_York', 'Australia/Lord_Howe']);
  const anchorDay = r.pick([1, 15, 28, 29, 30, 31]);
  const month = r.pick([0, 2, 4, 6, 7, 9, 11]); // months with 31 days, so every anchorDay exists
  const anchorWall = Date.UTC(2025, month, anchorDay, r.int(0, 23));
  const anchor = tz.resolveWall(zone, anchorWall);
  const months = r.pick([1, 2, 3, 12]);
  const calendar = billingCalendar(`P${months}M`, zone, anchor);
  for (const p of calendar.periods(anchor, anchor + 3 * 366 * DAY)) {
    if (p.start < anchor) continue;
    const wall = new Date(tz.toWall(zone, p.start));
    const last = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
    const atGap = tz.offsetAt(zone, p.start - 1) < tz.offsetAt(zone, p.start);
    if (!atGap) assert.equal(wall.getUTCDate(), Math.min(anchorDay, last), `${zone} anchor day ${anchorDay}: ${iso(p.start)}`);
  }
});
