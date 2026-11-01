'use strict';

/**
 * Seeded scenario generator for differential coverage testing.
 *
 * generateScenario(seed) returns { seed, flavors, input }, where input has the
 * canonical vector input shape (case.schema.json definitions/input). The same
 * seed always yields the same input. Each scenario mixes one to three
 * "flavors" weighted toward the cases implementations get wrong:
 *
 *   dst            account zone with midnight or 30-minute transitions
 *                  (Santiago, Havana, Cairo, Lord Howe), periods around them
 *   month_end      P1M / P3M billing cycles anchored on the 29th to 31st
 *   subdaily       sub-daily account_timezone periods (PT30M to PT6H)
 *   cutover        several versions changing duration, alignment, match,
 *                  purpose, or onto a billing feed (stub)
 *   regrant        revoke and re-grant chains around status_retention_days
 *   exceptions     excluded[] and gaps[] entries
 *   capacity       max_accounts capacity, account-wide and per offering
 *   cancellation   canceled_at, cancellation_effective_at, completed_at
 *   flight_history retroactive flight edits
 *   inactive       deactivation and reactivation
 *   availability   available_from / withdrawn_at on offerings
 *   tz_cutover     account timezone change (timezone_cutovers)
 *   membership     in-place account_ids / exclude_account_ids edits (excluded_by_buyer)
 *   invalid        an input an SDK must refuse (bad duration, zone, missing field)
 *
 * Instants are drawn near boundaries (UTC midnights, local midnights, DST
 * transitions) and nudged by a millisecond to an hour, where off-by-one
 * errors live.
 */

const path = require('node:path');
const env = require('../lib/env.cjs');

const tz = require(path.join(env.ROOT, 'scripts/reference/reporting-coverage/tz.cjs'));
const { format } = require(path.join(env.ROOT, 'scripts/reference/reporting-coverage/coverage.cjs'));
const { localCalendar } = require(path.join(env.ROOT, 'scripts/reference/reporting-coverage/calendar.cjs'));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: list => list[Math.floor(next() * list.length)],
    bool: (p = 0.5) => next() < p,
    weighted: entries => {
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let x = next() * total;
      for (const [value, w] of entries) {
        x -= w;
        if (x < 0) return value;
      }
      return entries[entries.length - 1][0];
    },
  };
  return r;
}

const DST_ZONES = ['America/Santiago', 'America/Havana', 'Africa/Cairo', 'Australia/Lord_Howe'];
const OTHER_ZONES = ['America/New_York', 'America/Los_Angeles', 'Asia/Kathmandu', 'Asia/Singapore', 'Asia/Tokyo', 'Pacific/Apia'];
const ALL_ZONES = [...DST_ZONES, ...OTHER_ZONES];

const FLAVORS = [
  ['dst', 6],
  ['month_end', 3],
  ['subdaily', 4],
  ['cutover', 5],
  ['regrant', 4],
  ['exceptions', 3],
  ['capacity', 2],
  ['cancellation', 3],
  ['flight_history', 3],
  ['inactive', 3],
  ['availability', 2],
  ['tz_cutover', 2],
  ['membership', 2],
  ['invalid', 1],
];

const PROFILE = {
  id: 'adcp.delivery.v1',
  version: '1.0.0',
  schema_uri: 'https://seller.example/schemas/delivery.json',
  schema_sha256: 'a'.repeat(64),
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
  grain: 'daily',
  primary_keys: ['account_id', 'package_id'],
};
const BILLING_PROFILE = {
  ...PROFILE,
  canonicalization_id: 'adcp_jcs_rows_v1',
  canonicalization_contract_version: '1.0',
  canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
  canonicalization_uri: 'https://seller.example/canonicalization/adcp_jcs_rows_v1.json',
  canonicalization_sha256: 'c'.repeat(64),
};
const METHOD = {
  pattern: 'file_transfer',
  transport: 's3',
  orchestration: 'producer_managed',
  destination_modes: ['existing'],
  provider: { domain: 'seller.example' },
  format: 'jsonl',
};

const iso = ms => format(ms);

/** Local midnight on the civil date of `instant` in `zone` (the first instant of that date). */
function localMidnight(zone, instant) {
  const offset = tz.offsetAt(zone, instant);
  const days = Math.floor((instant + offset) / DAY);
  // Resolve the wall midnight; a skipped midnight resolves to the first instant after the gap.
  let guess = days * DAY - tz.offsetAt(zone, days * DAY);
  guess = days * DAY - tz.offsetAt(zone, guess);
  return guess;
}

function transitionsNear(zone, lo, hi) {
  return tz
    .transitions(zone)
    .map(t => t.at)
    .filter(at => Number.isFinite(at) && at >= lo && at <= hi);
}

function generateScenario(seed) {
  const r = rng(seed);
  const flavors = new Set();
  const count = r.weighted([[1, 3], [2, 4], [3, 3]]);
  while (flavors.size < count) flavors.add(r.weighted(FLAVORS));
  const has = name => flavors.has(name);

  // --- account zone and the instant T0 the scenario is built around ---------------------------
  const zone = has('dst') ? r.pick(DST_ZONES) : r.bool(0.5) ? r.pick(ALL_ZONES) : r.pick(DST_ZONES);
  let t0;
  if (has('dst')) {
    const list = transitionsNear(zone, Date.UTC(2024, 0, 1), Date.UTC(2028, 0, 1));
    t0 = r.pick(list) + r.pick([0, 0, -DAY, DAY, -2 * HOUR, 2 * HOUR]);
  } else if (has('month_end')) {
    const year = r.int(2024, 2027);
    const month = r.int(0, 11);
    t0 = Date.UTC(year, month + 1, 0, r.pick([0, 4, 5, 12, 23]));
  } else {
    t0 = Date.UTC(r.int(2024, 2027), r.int(0, 11), r.int(1, 28), r.pick([0, 0, 3, 5, 12, 17]));
  }

  // --- durations --------------------------------------------------------------------------------
  const subdaily = ['PT1H', 'PT2H', 'PT30M', 'PT6H', 'PT3H', 'PT4H', 'PT12H', 'PT15M'];
  const longer = ['P1M', 'P3M', 'P7D', 'P1Y'];
  const pickDuration = () =>
    has('subdaily')
      ? r.pick(subdaily)
      : has('month_end')
        ? r.pick(['P1M', 'P1M', 'P3M', 'P1D'])
        : r.weighted([['P1D', 8], ['PT24H', 1], ['PT1H', 1], ['PT6H', 1], ['P7D', 1], ['P1M', 1], ['PT30M', 0.5], ['P1Y', 0.2], ['P3M', 0.3]]);
  const durations = [pickDuration()];
  if (has('cutover') && r.bool(0.6)) durations.push(pickDuration());
  // An invalid scenario carries exactly one defect: an invalid local duration, or one mutation below.
  const invalidDuration = has('invalid') && r.bool(0.4);
  if (invalidDuration) durations.push(r.pick(['PT7H', 'P1DT12H', 'PT90M', 'PT25H']));
  const span = durations.some(d => longer.includes(d))
    ? r.int(60, 200) * DAY
    : durations.some(d => ['PT15M', 'PT30M', 'PT1H'].includes(d))
      ? r.int(2, 5) * DAY
      : r.int(5, 24) * DAY;

  // --- instants near boundaries ------------------------------------------------------------------
  const boundaries = [];
  for (let t = t0 - span; t <= t0 + span; t += DAY) {
    boundaries.push(Math.floor(t / DAY) * DAY);
    boundaries.push(localMidnight(zone, t));
  }
  boundaries.push(...transitionsNear(zone, t0 - span, t0 + span));
  const nudge = () => r.weighted([[0, 6], [1, 1], [-1, 1], [1000, 0.5], [30 * MINUTE, 1], [-30 * MINUTE, 1], [HOUR, 1], [-HOUR, 1], [15 * MINUTE, 0.5]]);
  /** An instant in [t0 + lo*span, t0 + hi*span], usually near a boundary. */
  const at = (lo, hi) => {
    const a = t0 + lo * span;
    const b = t0 + hi * span;
    if (r.bool(0.65)) {
      const near = boundaries.filter(t => t >= a && t <= b);
      if (near.length) return r.pick(near) + nudge();
    }
    return Math.round((a + r.next() * (b - a)) / (15 * MINUTE)) * 15 * MINUTE + (r.bool(0.1) ? r.pick([1, 30 * MINUTE]) : 0);
  };

  // --- offerings ---------------------------------------------------------------------------------
  const offerings = [];
  let offeringSeq = 0;
  const addOffering = ({ duration, alignment, purpose = 'analytics', dims = ['package'], extra = {} }) => {
    const id = `off_${String.fromCharCode(97 + offeringSeq)}_${alignment.replace(/_.*/, '')}_${duration.toLowerCase()}`;
    offeringSeq += 1;
    const schedule = { period_duration: duration, alignment, delivery_sla: purpose === 'billing' ? 'P1D' : 'PT6H', ...extra };
    const offering = {
      offering_id: id,
      feed_purpose: purpose,
      report_definition_id: `rd_${id}`,
      report_definition_uri: `https://seller.example/report-definitions/${id}.json`,
      report_definition_sha256: 'b'.repeat(64),
      reporting_profile: purpose === 'billing' ? BILLING_PROFILE : PROFILE,
      schedule,
      supported_finality: ['official'],
      reconciliation_mode: purpose === 'billing' ? 'consumer_receipt' : 'delivery_only',
      standard_dimensions: dims,
    };
    if (purpose === 'billing') offering.method = METHOD;
    if (r.bool(0.1)) offering.unmapped_dimensions = ['device'];
    offerings.push(offering);
    return offering;
  };
  const billing = has('month_end') || (has('cutover') && r.bool(0.35));
  for (const duration of durations) {
    const calendarish = /^P\d+[MY]$/.test(duration);
    if (calendarish && billing) {
      const anchorDay = r.pick([28, 29, 30, 31, 1, 15]);
      const anchorYear = r.pick([2024, 2025, 2026]);
      const anchorMonth = anchorDay > 28 ? r.pick([0, 2, 4, 6, 7, 9, 11, 1]) : r.int(0, 11);
      const anchorZone = r.pick(['America/New_York', zone, 'UTC']);
      const wall = Date.UTC(anchorYear, anchorMonth, Math.min(anchorDay, tz.daysInMonth(anchorYear, anchorMonth + 1)));
      const anchor = anchorZone === 'UTC' ? wall : wall - tz.offsetAt(anchorZone, wall);
      addOffering({
        duration,
        alignment: 'billing_cycle',
        purpose: 'billing',
        extra: { period_anchor_policy: 'fixed', period_anchor: iso(anchor), period_timezone: anchorZone },
      });
    }
    const aligns = r.weighted([
      [['utc', 'account_timezone'], 5],
      [['account_timezone'], 3],
      [['utc'], 1],
      [['account_timezone', 'source_timezone'], 1],
    ]);
    for (const alignment of aligns) {
      if (alignment === 'source_timezone') {
        addOffering(
          r.bool()
            ? { duration, alignment, extra: { period_timezone_policy: 'fixed', period_timezone: r.pick(ALL_ZONES) } }
            : { duration, alignment, extra: { period_timezone_policy: 'account_resolved' } },
        );
      } else {
        addOffering({ duration, alignment });
      }
    }
    if (r.bool(0.3)) addOffering({ duration, alignment: r.pick(['utc', 'account_timezone']), dims: ['package', 'creative'] });
    if (billing && !calendarish && r.bool(0.7)) addOffering({ duration, alignment: r.pick(['utc', 'account_timezone']), purpose: 'billing' });
  }
  if (has('availability')) {
    for (const offering of offerings) {
      if (r.bool(0.4)) offering.available_from = iso(at(-0.6, 0.4));
      else if (r.bool(0.3)) offering.withdrawn_at = iso(at(-0.3, 0.6));
    }
  }

  // --- versions ------------------------------------------------------------------------------------
  const versionCount = has('cutover') ? r.int(2, 4) : r.weighted([[1, 6], [2, 2], [3, 1]]);
  const versions = [];
  let accepted = at(-0.9, -0.4);
  const purposes = [...new Set(offerings.map(o => o.feed_purpose))];
  for (let n = 1; n <= versionCount; n += 1) {
    const duration = r.pick(durations);
    const purpose = n > 1 && billing && r.bool(0.5) ? 'billing' : r.pick(purposes);
    const selector = { feed_purpose: purpose, period_duration: duration, required_finality: 'official', dimensions: ['package'] };
    // Usually an alignment some offering for this purpose and duration publishes, so the selector matches.
    const published = offerings
      .filter(o => o.feed_purpose === purpose && o.schedule.period_duration === duration && ['utc', 'account_timezone'].includes(o.schedule.alignment))
      .map(o => o.schedule.alignment);
    const alignment = r.bool(0.4) ? undefined : published.length && r.bool(0.9) ? r.pick(published) : r.pick(['utc', 'account_timezone']);
    if (alignment) selector.alignment = alignment;
    // Billing selectors are match: exact (core/reporting-subscription.json allOf).
    const match = purpose === 'billing' ? r.pick([undefined, 'exact']) : r.weighted([[undefined, 3], ['exact', 1], ['finest', 2], ['all', 2]]);
    if (match) selector.match = match;
    let scope = r.weighted([[{ all_authorized_accounts: true }, 6], [{ account_ids: ['acct_1'] }, 2], [{ account_ids: ['acct_other'] }, 0.3]]);
    if (r.bool(0.08)) {
      // period_timezone needs a single-account scope.
      selector.period_timezone = r.pick([zone, 'Asia/Tokyo', 'America/New_York']);
      scope = { account_ids: ['acct_1'] };
    }
    const configuration = {
      subscription_id: 'sub',
      subscription_version: n,
      active: true,
      scope,
      selector,
      reconciliation_mode: purpose === 'billing' ? 'consumer_receipt' : 'delivery_only',
    };
    if (configuration.scope.all_authorized_accounts && r.bool(0.1)) configuration.exclude_account_ids = [r.pick(['acct_other', 'acct_other', 'acct_1'])];
    if (r.bool(0.04)) configuration.operator_domains = ['agency.example'];
    const version = { subscription_version: n, accepted_at: iso(accepted), configuration };
    if (purpose === 'billing') {
      configuration.destination = { destination_id: 'billing-archive' };
      version.destination_method = { pattern: 'file_transfer', transport: 's3' };
    }
    versions.push(version);
    const next = accepted + r.int(1, Math.max(2, Math.round(span / HOUR / 3))) * HOUR + r.pick([0, 0, 15 * MINUTE, 1]);
    if (n < versionCount) {
      if (r.bool(0.4)) version.superseded_at = iso(next);
      // Sometimes the next version lands on a period boundary.
      accepted = r.bool(0.3) ? r.pick(boundaries.filter(t => t > accepted).slice(0, 40)) ?? next : next;
      if (version.superseded_at) version.superseded_at = iso(accepted);
    }
  }

  // --- account and grants --------------------------------------------------------------------------
  const account = { account_id: 'acct_1', timezone: zone, grants: [] };
  if (versions.some(v => v.configuration.operator_domains)) account.operator = r.pick(['agency.example', 'agency.example', 'other-agency.example']);
  if (offerings.some(o => o.schedule.period_timezone_policy === 'account_resolved')) account.source_timezone = r.pick([zone, 'America/New_York']);
  const retention = r.int(1, 5);
  let grantStart = r.bool(0.8) ? at(-1, -0.6) : at(-0.6, 0);
  account.grants.push({ authorized_at: iso(grantStart) });
  if (has('regrant')) {
    const chainStart = grantStart;
    let cursor = grantStart;
    for (let g = 0; g < r.int(1, 3); g += 1) {
      const revoked = Math.max(cursor + HOUR, at(-0.4, 0.5));
      account.grants[account.grants.length - 1].unauthorized_at = iso(revoked);
      const kind = r.weighted([['chain_start', 2], ['inside', 3], ['at_limit', 1], ['after', 2]]);
      let regrant;
      if (kind === 'chain_start') regrant = chainStart;
      else if (kind === 'inside') regrant = revoked + r.int(1, retention * 24 - 1) * HOUR;
      else if (kind === 'at_limit') regrant = revoked + retention * DAY;
      else regrant = revoked + retention * DAY + r.int(1, 72) * HOUR;
      account.grants.push({ authorized_at: iso(regrant) });
      cursor = Math.max(revoked, regrant);
    }
  }

  // --- buys --------------------------------------------------------------------------------------
  const buys = [];
  for (let b = 0; b < r.weighted([[1, 4], [2, 3], [3, 1]]); b += 1) {
    const start = at(-0.6, 0.2);
    const end = start + r.weighted([[r.int(2, 14) * DAY, 4], [Math.round(span * (0.3 + r.next())), 3], [r.int(1, 48) * HOUR, 1], [0, 0.2]]) + r.pick([0, 0, 1, 30 * MINUTE]);
    const packages = [];
    for (let p = 0; p < r.weighted([[1, 4], [2, 1]]); p += 1) {
      let ids = offerings.filter(() => r.bool(0.85)).map(o => o.offering_id);
      // A package with no offerings owes nothing; keep that rare.
      if (ids.length === 0 && r.bool(0.9)) ids = [r.pick(offerings).offering_id];
      packages.push({ package_id: `pkg_${p + 1}`, reporting_delivery_offering_ids: ids });
    }
    // Late confirmation lands inside the flight, so it trims rather than empties it.
    const late = start + Math.min(r.int(1, 72) * HOUR, Math.max(HOUR, Math.round((end - start) / 2)));
    const buy = {
      media_buy_id: `mb_${b + 1}`,
      confirmed_at: r.weighted([[iso(start - r.int(0, 72) * HOUR), 6], [iso(late), 2], [null, 0.4], [undefined, 0.2]]),
      start_time: iso(start),
      end_time: iso(end),
      packages,
    };
    if (buy.confirmed_at === undefined) delete buy.confirmed_at;
    if (has('cancellation') && r.bool(0.7)) {
      const kind = r.pick(['canceled', 'notice', 'completed']);
      if (kind === 'completed') buy.completed_at = iso(start + Math.round((end - start) * r.next()));
      else {
        const canceled = start + Math.round((end - start) * (r.next() * 1.2 - 0.1));
        buy.canceled_at = iso(canceled);
        if (kind === 'notice') buy.cancellation_effective_at = iso(canceled + r.int(1, 96) * HOUR);
      }
    }
    if (has('flight_history') && r.bool(0.8)) {
      const history = [];
      let recorded = start + r.int(-48, 72) * HOUR;
      for (let e = 0; e < r.int(1, 3); e += 1) {
        const prevStart = start + r.int(-2, 1) * DAY;
        const prevStop = prevStart + r.int(1, 12) * DAY + r.pick([0, 0, 1, HOUR]);
        history.push({ recorded_at: iso(recorded), start_time: iso(prevStart), stop_time: iso(prevStop) });
        recorded += r.int(1, 96) * HOUR;
      }
      buy.flight_history = history;
    }
    buys.push(buy);
  }

  const input = {
    subscription_id: 'sub',
    versions,
    account,
    buys,
    offerings,
    now: iso(r.bool(0.85) ? at(0.5, 1) : at(-0.1, 0.5)),
  };
  if (account.grants.length > 1 || r.bool(0.3)) input.status_retention_days = retention;
  if (r.bool(0.25)) input.backfill_on_regrant = true;

  // --- coverage exceptions -------------------------------------------------------------------------
  const coverage = {};
  if (has('exceptions') || has('capacity') || (has('regrant') && r.bool(0.5))) {
    const excluded = [];
    const gaps = [];
    if (has('capacity')) {
      for (let i = 0; i < r.int(1, 2); i += 1) {
        const from = at(-0.6, 0.6);
        const entry = { reason: 'capacity', from: iso(from) };
        if (r.bool(0.5)) entry.offering_id = r.pick(offerings).offering_id;
        if (r.bool(0.6)) entry.until = iso(from + r.int(1, 7 * 24) * HOUR);
        excluded.push(entry);
      }
    }
    if (has('exceptions')) {
      for (let i = 0; i < r.int(1, 3); i += 1) {
        const from = at(-0.6, 0.6);
        // excluded_by_buyer records membership edits; the membership flavor writes those consistently with scope.
        const reason = r.pick(['offering_unsupported', 'overridden', 'capacity']);
        const entry = { reason, from: iso(from) };
        if (reason === 'offering_unsupported' || (reason === 'overridden' && r.bool(0.3))) entry.media_buy_id = r.pick(buys).media_buy_id;
        if (entry.media_buy_id && r.bool(0.3)) entry.package_ids = [r.pick(['pkg_1', 'pkg_2', 'pkg_9'])];
        if (reason === 'overridden') entry.overridden_by = { delivery_config_id: 'acme-analytics' };
        if (r.bool(0.3)) entry.offering_id = r.pick(offerings).offering_id;
        if (r.bool(0.6)) entry.until = iso(from + r.int(1, 5 * 24) * HOUR);
        excluded.push(entry);
      }
    }
    if (has('regrant') || (has('exceptions') && r.bool(0.4))) {
      for (const grant of account.grants.slice(0, -1)) {
        if (r.bool(0.6)) {
          const from = Date.parse(grant.unauthorized_at);
          const gap = { from: iso(from), until: iso(from + r.int(1, 72) * HOUR), reason: 'unauthorized' };
          if (r.bool(0.2)) gap.offering_id = r.pick(offerings).offering_id;
          gaps.push(gap);
        }
      }
    }
    if (excluded.length) coverage.excluded = excluded;
    if (gaps.length) coverage.gaps = gaps;
  }
  if (has('tz_cutover')) {
    // effective_at is "the end of the last old-timezone period that started before the change", so it is a
    // boundary of each offering's old schedule; offerings whose boundaries differ get one entry each.
    const previous = r.pick(ALL_ZONES.filter(z => z !== zone));
    const change = at(-0.4, 0.5);
    const local = offerings.filter(o => o.schedule.alignment === 'account_timezone');
    const endAfter = duration => {
      try {
        const period = localCalendar(duration, previous)
          .periods(change - 400 * DAY, change + 400 * DAY)
          .find(p => p.start < change && p.end >= change);
        return period ? period.end : change;
      } catch {
        return change; // an invalid duration: the input is refused anyway
      }
    };
    const ends = new Map(local.map(o => [o.offering_id, endAfter(o.schedule.period_duration)]));
    const distinct = new Set(ends.values());
    if (distinct.size <= 1 && !r.bool(0.2)) {
      coverage.timezone_cutovers = [{ effective_at: iso(distinct.size ? [...distinct][0] : change), timezone: zone, previous_timezone: previous }];
    } else {
      coverage.timezone_cutovers = local.map(o => ({
        offering_id: o.offering_id,
        effective_at: iso(ends.get(o.offering_id)),
        timezone: zone,
        previous_timezone: previous,
      }));
      if (coverage.timezone_cutovers.length === 0) delete coverage.timezone_cutovers;
    }
  }
  if (has('membership')) {
    // reporting-subscription.json membership: edits apply in place to the current version and are recorded
    // per account as excluded_by_buyer intervals.
    const last = versions[versions.length - 1];
    const accepted = Date.parse(last.accepted_at);
    // An edit the readback reports has already happened: before now.
    const edit = Math.min(Math.max(accepted + HOUR, at(-0.3, 0.6)), Date.parse(input.now) - HOUR);
    const kind = r.pick(['removed', 'readded', 'joined_late']);
    const excluded = (coverage.excluded ??= []);
    if (kind === 'removed') {
      // period_timezone needs a single-account account_ids scope.
      if (r.bool() || last.configuration.selector.period_timezone) {
        last.configuration.scope = { account_ids: ['acct_other'] };
        delete last.configuration.exclude_account_ids;
      }
      else {
        last.configuration.scope = { all_authorized_accounts: true };
        last.configuration.exclude_account_ids = ['acct_1'];
      }
      excluded.push({ reason: 'excluded_by_buyer', from: iso(edit) });
    } else if (kind === 'readded') {
      if (last.configuration.scope.account_ids) last.configuration.scope = { account_ids: ['acct_1'] };
      delete last.configuration.exclude_account_ids;
      excluded.push({ reason: 'excluded_by_buyer', from: iso(edit), until: iso(edit + r.int(1, 6 * 24) * HOUR) });
    } else {
      last.configuration.scope = { account_ids: ['acct_1'] };
      delete last.configuration.exclude_account_ids;
      excluded.push({ reason: 'excluded_by_buyer', from: iso(accepted), until: iso(edit) });
    }
  }
  if (Object.keys(coverage).length) input.coverage = coverage;

  // --- activity --------------------------------------------------------------------------------------
  if (has('inactive')) {
    const last = versions[versions.length - 1];
    const from = Math.max(Date.parse(versions[0].accepted_at) + HOUR, at(-0.4, 0.5));
    if (r.bool(0.35)) {
      last.deactivated_at = iso(Math.max(from, Date.parse(last.accepted_at)));
      last.configuration.active = false;
    } else {
      input.inactive_intervals = [{ deactivated_at: iso(from), reactivated_at: iso(from + r.int(1, 6 * 24) * HOUR + r.pick([0, 0, 30 * MINUTE])) }];
    }
  }

  // --- deliberate input errors ----------------------------------------------------------------------
  if (has('invalid') && !invalidDuration) {
    const mutation = r.pick(['offset_zone', 'missing_zone', 'unknown_zone', 'missing_retention', 'missing_previous', 'week', 'missing_dims']);
    if (mutation === 'offset_zone') account.timezone = r.pick(['+05:00', 'UTC+3', 'GMT-4']);
    else if (mutation === 'missing_zone') delete account.timezone;
    else if (mutation === 'unknown_zone') account.timezone = 'Mars/Olympus_Mons';
    else if (mutation === 'missing_retention') {
      if (account.grants.length < 2) {
        const revoked = Math.max(Date.parse(account.grants[0].authorized_at) + HOUR, at(-0.3, 0.2));
        account.grants[0].unauthorized_at = iso(revoked);
        account.grants.push({ authorized_at: iso(revoked + DAY) });
      }
      delete input.status_retention_days;
    } else if (mutation === 'missing_previous') {
      input.coverage = { ...(input.coverage ?? {}), timezone_cutovers: [{ effective_at: iso(at(-0.3, 0.3)), timezone: zone }] };
    } else if (mutation === 'week') {
      offerings[0].schedule.period_duration = 'P1W';
      versions[0].configuration.selector.period_duration = 'P1W';
    } else if (mutation === 'missing_dims') delete r.pick(offerings).standard_dimensions;
  }

  return { seed, flavors: [...flavors].sort(), input };
}

module.exports = { generateScenario, rng, FLAVORS };
