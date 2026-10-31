'use strict';

/**
 * Reference model for AdCP 3.3 reporting-subscription coverage
 * (experimental media_buy.reporting_subscriptions).
 *
 * Written from the spec text alone, deliberately brute force: it enumerates
 * every period of every schedule in play and keeps a period only when each
 * clause of the rule admits it. Each clause is one predicate, named after the
 * text it implements, and the owed set is their intersection:
 *
 *   owed(buy, offering, period) =
 *       cutover    -- the side that owns the period, between its handoffs
 *     ∩ authority  -- authorization chains, gaps between grants
 *     ∩ confirmed  -- ends after confirmed_at
 *     ∩ flight     -- overlaps the flight in effect at the period end
 *     ∩ ¬excepted  -- no excluded[] or gaps[] entry covers its start
 *     ∩ resolved   -- has ended by now; not zero-length
 *
 * Normative sources, quoted where used:
 *   static/schemas/source/core/reporting-subscription.json x-adcp-validation
 *     (coverage, cutover, selection)
 *   static/schemas/source/core/reporting-schedule.json period_generation
 *   static/schemas/source/core/reporting-subscription-coverage.json
 *   static/schemas/source/core/reporting-subscription-state.json
 *   static/schemas/source/core/account-authorization.json authorized_at
 *   docs/media-buy/task-reference/get_reporting_status.mdx#subscription-coverage
 *
 * The model is a test oracle, not a library: it favors obviousness over speed,
 * and it carries only the time zones in tzdata.json.
 *
 * Input and output shapes are those of the vectors in
 * static/compliance/source/test-vectors/reporting-subscriptions/ (see
 * case.schema.json there).
 */

const tz = require('./tz.cjs');
const { CoverageInputError, parseDuration, utcCalendar, localCalendar, billingCalendar, DAY } = require('./calendar.cjs');

const UTC_ALIASES = new Set(['UTC', 'Etc/UTC']);

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

/** RFC 3339 date-time to integer milliseconds. Sub-millisecond digits must be zero. */
function instant(text, label) {
  const match = typeof text === 'string' ? RFC3339.exec(text) : null;
  if (!match) throw new CoverageInputError('invalid_instant', `${label}: ${JSON.stringify(text)} is not an RFC 3339 date-time`);
  const [, y, mo, d, h, mi, s, frac = '', zone] = match;
  if (/[1-9]/.test(frac.slice(3))) {
    throw new CoverageInputError('invalid_instant', `${label}: the reference model carries millisecond precision`);
  }
  const ms = Number(frac.slice(0, 3).padEnd(3, '0'));
  let offset = 0;
  if (!/^[Zz]$/.test(zone)) offset = (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
  return tz.daysFromCivil(Number(y), Number(mo), Number(d)) * DAY + ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + ms - offset;
}

function format(ms) {
  const iso = new Date(ms).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, 19)}Z` : iso;
}

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Time zones used by schedules
// ---------------------------------------------------------------------------

function checkZone(name, label, used) {
  // reporting-schedule.json iana_timezone: a recognized IANA zone name or link; a numeric offset is not one.
  if (!tz.isIanaName(name)) throw new CoverageInputError('invalid_timezone', `${label}: ${JSON.stringify(name)} is not an IANA time zone`);
  if (!tz.hasZone(name)) throw new Error(`${label}: ${name} is valid but not in the reference model's pinned subset; add it to tzdata.json`);
  used.add(name);
  return name;
}

/**
 * The account timezone in effect for periods starting at each instant, per
 * offering: timezone_cutovers entries (offering-scoped or account-wide), with
 * previous_timezone before the first effective_at.
 */
function accountZoneTimeline(input, offeringId, used) {
  const entries = (input.coverage?.timezone_cutovers ?? [])
    .filter(entry => entry.offering_id === undefined || entry.offering_id === offeringId)
    .map(entry => {
      if (entry.previous_timezone === undefined) {
        // reporting-subscription-coverage.json: "Sellers MUST include it ... a buyer cannot otherwise recover the old schedule."
        throw new CoverageInputError('missing_previous_timezone', 'a timezone_cutovers entry has no previous_timezone');
      }
      return { at: instant(entry.effective_at, 'timezone_cutovers.effective_at'), from: entry.previous_timezone, to: entry.timezone };
    })
    .sort((a, b) => a.at - b.at);
  if (entries.length === 0) {
    if (input.account.timezone === undefined) {
      throw new CoverageInputError('missing_account_timezone', 'an account_timezone offering resolves and the account has no timezone');
    }
    return [{ from: -Infinity, zone: checkZone(input.account.timezone, 'account.timezone', used) }];
  }
  const timeline = [{ from: -Infinity, zone: checkZone(entries[0].from, 'timezone_cutovers.previous_timezone', used) }];
  for (const entry of entries) timeline.push({ from: entry.at, zone: checkZone(entry.to, 'timezone_cutovers.timezone', used) });
  return timeline;
}

// ---------------------------------------------------------------------------
// Schedules: an offering's published schedule under one version
// ---------------------------------------------------------------------------

/**
 * A schedule is a list of pieces, each a calendar owning the periods that start
 * in [from, until). Only an account_timezone offering whose account changed
 * timezone has more than one piece.
 */
function scheduleFor(offering, version, input, used) {
  const schedule = offering.schedule;
  const override = version.config.selector.period_timezone;
  const duration = schedule.period_duration;
  switch (schedule.alignment) {
    case 'utc':
      return { key: `utc|${duration}`, pieces: [{ from: -Infinity, until: Infinity, calendar: utcCalendar(duration) }] };
    case 'account_timezone': {
      // reporting-subscription.json selector.period_timezone: "An account_timezone offering matches and uses this zone in place of the account's."
      const timeline = override !== undefined
        ? [{ from: -Infinity, zone: checkZone(override, 'selector.period_timezone', used) }]
        : accountZoneTimeline(input, offering.offering_id, used);
      const pieces = timeline.map((entry, index) => ({
        from: entry.from,
        until: index + 1 < timeline.length ? timeline[index + 1].from : Infinity,
        calendar: localCalendar(duration, entry.zone),
      }));
      return { key: JSON.stringify(pieces.map(piece => [piece.from, piece.calendar.key])), pieces };
    }
    case 'source_timezone': {
      let zone = schedule.period_timezone;
      if (schedule.period_timezone_policy === 'account_resolved') {
        if (input.account.source_timezone === undefined) {
          throw new CoverageInputError('missing_source_timezone', `${offering.offering_id} resolves its source timezone per account`);
        }
        zone = input.account.source_timezone;
      }
      checkZone(zone, 'source timezone', used);
      return { key: `local|${zone}|${duration}`, pieces: [{ from: -Infinity, until: Infinity, calendar: localCalendar(duration, zone) }] };
    }
    case 'billing_cycle': {
      const zone = checkZone(schedule.period_timezone, 'schedule.period_timezone', used);
      const anchor = instant(schedule.period_anchor, 'schedule.period_anchor');
      return { key: `billing|${zone}|${anchor}|${duration}`, pieces: [{ from: -Infinity, until: Infinity, calendar: billingCalendar(duration, zone, anchor) }] };
    }
    default:
      throw new CoverageInputError('invalid_input', `unknown alignment ${schedule.alignment}`);
  }
}

/** Every period of a schedule overlapping [lo, hi], tagged with the piece that owns it. */
function schedulePeriods(schedule, lo, hi) {
  const out = [];
  for (const piece of schedule.pieces) {
    for (const period of piece.calendar.periods(lo, hi)) {
      if (period.start >= piece.from && period.start < piece.until) out.push(period);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------------------------------------------------------------------------
// Selection (reporting-subscription.json selection, selector.match)
// ---------------------------------------------------------------------------

function canProduceTimezone(schedule, override) {
  // "A billing_cycle offering whose anchor the buyer configures never matches a subscription."
  if (schedule.alignment === 'billing_cycle' && schedule.period_anchor_policy !== 'fixed') return false;
  if (override === undefined) return true;
  switch (schedule.alignment) {
    case 'utc':
      return UTC_ALIASES.has(override); // "A utc offering matches only when this is a UTC alias (UTC or Etc/UTC)."
    case 'account_timezone':
      return true;
    case 'source_timezone':
    case 'billing_cycle':
      return schedule.period_timezone !== undefined && schedule.period_timezone === override;
    default:
      return false;
  }
}

function availableAt(offering, at) {
  if (offering.available_from !== undefined && instant(offering.available_from, 'available_from') > at) return false;
  if (offering.withdrawn_at !== undefined && instant(offering.withdrawn_at, 'withdrawn_at') <= at) return false;
  return true;
}

/** Offerings one package resolves to under a version at instant `at`, as offering_ids. */
function resolvePackage(pkg, version, offeringsById, at) {
  const { selector, reconciliation_mode: mode } = version.config;
  const method = version.destinationMethod;
  const candidates = [];
  for (const id of pkg.reporting_delivery_offering_ids) {
    const offering = offeringsById.get(id);
    if (offering === undefined || !availableAt(offering, at)) continue;
    const schedule = offering.schedule;
    if (offering.feed_purpose !== selector.feed_purpose) continue;
    if (schedule.period_duration !== selector.period_duration) continue; // "matched exactly"
    if (offering.reconciliation_mode !== mode) continue;
    if (!offering.supported_finality.includes(selector.required_finality)) continue;
    if (selector.alignment !== undefined && schedule.alignment !== selector.alignment) continue;
    if (method === undefined) {
      if (offering.method !== undefined) continue; // "Omit to select only API-delivered (Core) offerings."
    } else if (offering.method === undefined || offering.method.pattern !== method.pattern || offering.method.transport !== method.transport) {
      continue;
    }
    if (!canProduceTimezone(schedule, selector.period_timezone)) continue;
    if (!Array.isArray(offering.standard_dimensions)) {
      // sync_principal: "Sellers advertising subscriptions MUST publish standard_dimensions on every offering."
      throw new CoverageInputError('missing_standard_dimensions', `${id} does not publish standard_dimensions`);
    }
    candidates.push(offering);
  }
  candidates.sort((a, b) => byteCompare(a.offering_id, b.offering_id));
  const wanted = selector.dimensions;
  const match = selector.match ?? (wanted !== undefined ? 'exact' : 'finest');
  const mapped = offering => new Set(offering.standard_dimensions);
  const includesWanted = offering => wanted === undefined || wanted.every(dimension => mapped(offering).has(dimension));
  if (match === 'exact') {
    const equal = candidates.filter(offering => {
      if (wanted === undefined) return true; // "With match exact and no dimensions, every candidate qualifies"
      const own = mapped(offering);
      const unmapped = offering.unmapped_dimensions ?? [];
      return unmapped.length === 0 && own.size === new Set(wanted).size && wanted.every(dimension => own.has(dimension));
    });
    return equal.slice(0, 1).map(offering => offering.offering_id);
  }
  const including = candidates.filter(includesWanted);
  if (match === 'all') return including.map(offering => offering.offering_id);
  const most = Math.max(-1, ...including.map(offering => mapped(offering).size));
  return including.filter(offering => mapped(offering).size === most).slice(0, 1).map(offering => offering.offering_id);
}

function inScope(config, account) {
  const scope = config.scope;
  let selected;
  if (scope.account_ids !== undefined) selected = scope.account_ids.includes(account.account_id);
  else selected = scope.all_authorized_accounts === true && !(config.exclude_account_ids ?? []).includes(account.account_id);
  if (!selected) return false;
  if (config.operator_domains !== undefined) return config.operator_domains.includes(account.operator);
  return true;
}

// ---------------------------------------------------------------------------
// Authority (coverage: "Authorization is evaluated as a chain")
// ---------------------------------------------------------------------------

/**
 * Chains of grants. Each chain starts at its first grant's authorized_at and
 * may end at a final unauthorized_at. An interruption inside a chain is
 * (unauthorized_at, re-grant instant); the re-grant instant is null when the
 * buyer saw only the chain-start authorized_at (any value at or before the
 * previous unauthorized_at), in which case only the seller's gaps[] say what
 * the interruption removed.
 */
function authorityChains(input) {
  const grants = input.account.grants;
  if (!Array.isArray(grants) || grants.length === 0) throw new CoverageInputError('invalid_input', 'account.grants must list at least one grant');
  const chains = [];
  let chain = null;
  grants.forEach((grant, index) => {
    const authorizedAt = instant(grant.authorized_at, `grants[${index}].authorized_at`);
    if (chain === null) chain = { start: authorizedAt, end: Infinity, interruptions: [] };
    else {
      const previous = grants[index - 1];
      if (previous.unauthorized_at === undefined) throw new CoverageInputError('invalid_input', `grants[${index - 1}] is followed by another grant but has no unauthorized_at`);
      const revokedAt = instant(previous.unauthorized_at, `grants[${index - 1}].unauthorized_at`);
      if (authorizedAt <= revokedAt) chain.interruptions.push({ revokedAt, regrantedAt: null });
      else {
        if (input.status_retention_days === undefined) {
          throw new CoverageInputError('missing_status_retention_days', 'a re-grant after a revocation needs status_retention_days to decide whether it continues the chain');
        }
        // account-authorization.json: "A re-grant before the previous unauthorized_at plus status_retention_days continues the chain"
        if (authorizedAt < revokedAt + input.status_retention_days * DAY) chain.interruptions.push({ revokedAt, regrantedAt: authorizedAt });
        else {
          chain.end = revokedAt;
          chains.push(chain);
          chain = { start: authorizedAt, end: Infinity, interruptions: [] };
        }
      }
    }
    if (index === grants.length - 1 && grant.unauthorized_at !== undefined) chain.end = instant(grant.unauthorized_at, `grants[${index}].unauthorized_at`);
  });
  chains.push(chain);
  return chains;
}

function authorized(chains, period, backfill) {
  return chains.some(chain => {
    // "the first boundary at or after ... the account's authorization.authorized_at": for a boundary, start >= authorized_at.
    if (period.start < chain.start) return false;
    // get_reporting_status: "None is delivered for periods ending after unauthorized_at."
    if (period.end > chain.end) return false;
    if (backfill) return true; // "With backfill_on_regrant true no gap is recorded"
    // gaps: from the last boundary at or before unauthorized_at until the first boundary at or after the re-grant,
    // i.e. the periods that end after unauthorized_at and start before the re-grant.
    return chain.interruptions.every(({ revokedAt, regrantedAt }) => regrantedAt === null || !(period.end > revokedAt && period.start < regrantedAt));
  });
}

// ---------------------------------------------------------------------------
// Flights ("Flight values are evaluated at each period's scope_resolved_at")
// ---------------------------------------------------------------------------

function flightOf(values, label) {
  const start = instant(values.start_time, `${label}.start_time`);
  const stops = [instant(values.end_time, `${label}.end_time`)];
  // coverage: "the cancellation's delivery stop (cancellation_effective_at, or cancellation.canceled_at when it is absent)"
  if (values.cancellation_effective_at !== undefined) stops.push(instant(values.cancellation_effective_at, `${label}.cancellation_effective_at`));
  else if (values.canceled_at !== undefined) stops.push(instant(values.canceled_at, `${label}.canceled_at`));
  if (values.completed_at !== undefined) stops.push(instant(values.completed_at, `${label}.completed_at`));
  return { start, stop: Math.min(...stops) };
}

/** Flight values in effect at an instant: a prior value applies before its replaced_at. */
function flightTimeline(buy) {
  const priors = (buy.prior_flights ?? [])
    .map((prior, index) => ({ until: instant(prior.replaced_at, `prior_flights[${index}].replaced_at`), flight: flightOf(prior, `prior_flights[${index}]`) }))
    .sort((a, b) => a.until - b.until);
  const current = flightOf(buy, buy.media_buy_id);
  return at => (priors.find(prior => at < prior.until) ?? { flight: current }).flight;
}

function overlapsFlight(period, flight) {
  // "A flight whose stop time is at or before its start_time ... overlaps no period and owes nothing."
  return flight.start < flight.stop && period.start < flight.stop && period.end > flight.start;
}

// ---------------------------------------------------------------------------
// Exceptions (excluded[] and gaps[]: "each removing periods; none adds one")
// ---------------------------------------------------------------------------

function exceptionWindows(coverage) {
  const windows = [];
  for (const [index, entry] of (coverage?.excluded ?? []).entries()) {
    // "these are removed from its coverage rather than its periods": package_ids entries remove packages, not periods.
    if (entry.package_ids !== undefined) continue;
    windows.push({
      mediaBuyId: entry.media_buy_id,
      offeringId: entry.offering_id,
      from: instant(entry.from, `excluded[${index}].from`),
      until: entry.until === undefined ? Infinity : instant(entry.until, `excluded[${index}].until`),
    });
  }
  for (const [index, entry] of (coverage?.gaps ?? []).entries()) {
    windows.push({
      offeringId: entry.offering_id,
      from: instant(entry.from, `gaps[${index}].from`),
      until: instant(entry.until, `gaps[${index}].until`),
    });
  }
  return windows;
}

function excepted(windows, buyId, offeringId, period) {
  return windows.some(window =>
    (window.mediaBuyId === undefined || window.mediaBuyId === buyId) &&
    (window.offeringId === undefined || window.offeringId === offeringId) &&
    period.start >= window.from && period.start < window.until);
}

// ---------------------------------------------------------------------------
// Versions, activity, and sides
// ---------------------------------------------------------------------------

function normalizeVersions(input) {
  const versions = input.versions.map((record, index) => {
    const config = record.configuration;
    if (config === undefined || config === null) {
      // prior_versions[].configuration: "Sellers MUST include it, so a buyer that lost local state can recompute"
      throw new CoverageInputError('missing_version_configuration', `versions[${index}] has no configuration`);
    }
    if (config.destination !== undefined && record.destination_method === undefined) {
      throw new CoverageInputError('missing_destination_method', `versions[${index}] names a destination without its destination_method`);
    }
    parseDuration(config.selector.period_duration);
    return {
      number: record.subscription_version,
      acceptedAt: instant(record.accepted_at, `versions[${index}].accepted_at`),
      config,
      destinationMethod: record.destination_method,
      record,
    };
  });
  for (let i = 1; i < versions.length; i += 1) {
    if (versions[i].acceptedAt <= versions[i - 1].acceptedAt || versions[i].number <= versions[i - 1].number) {
      throw new CoverageInputError('invalid_input', 'versions must be in accepted_at and subscription_version order');
    }
  }
  versions.forEach((version, index) => {
    // prior_versions superseded_at: "The next version's accepted_at, the cutover instant"
    version.endsAt = index + 1 < versions.length ? versions[index + 1].acceptedAt : Infinity;
    if (version.record.superseded_at !== undefined && instant(version.record.superseded_at, 'superseded_at') !== version.endsAt) {
      throw new CoverageInputError('invalid_input', `versions[${index}].superseded_at is not the next version's accepted_at`);
    }
  });
  return versions;
}

/** inactive_intervals plus a current deactivated_at, as [from, until) windows. */
function inactiveWindows(input) {
  const windows = (input.inactive_intervals ?? []).map((interval, index) => ({
    from: instant(interval.deactivated_at, `inactive_intervals[${index}].deactivated_at`),
    until: interval.reactivated_at === undefined ? Infinity : instant(interval.reactivated_at, `inactive_intervals[${index}].reactivated_at`),
  }));
  for (const [index, record] of input.versions.entries()) {
    if (record.deactivated_at === undefined) continue;
    const from = instant(record.deactivated_at, `versions[${index}].deactivated_at`);
    if (!windows.some(window => window.from === from)) windows.push({ from, until: Infinity });
  }
  return windows;
}

/**
 * The side in effect at instant t for one buy: the version, and each offering
 * its packages resolve to with that offering's schedule; or null when no
 * version is active and in scope (before the first version, while inactive,
 * or out of scope).
 */
function sideAt(t, ctx, buy) {
  const version = ctx.versions.find(candidate => t >= candidate.acceptedAt && t < candidate.endsAt);
  if (version === undefined) return null;
  if (ctx.inactive.some(window => t >= window.from && t < window.until)) return null;
  if (!inScope(version.config, ctx.input.account)) return null;
  const ids = new Set();
  for (const pkg of buy.packages) {
    // "The seller resolves the selector separately for each account and each buy's products."
    for (const id of resolvePackage(pkg, version, ctx.offeringsById, t)) ids.add(id);
  }
  const offerings = new Map();
  for (const id of [...ids].sort(byteCompare)) {
    const key = JSON.stringify([id, version.number]);
    if (!ctx.schedules.has(key)) ctx.schedules.set(key, scheduleFor(ctx.offeringsById.get(id), version, ctx.input, ctx.zonesUsed));
    offerings.set(id, ctx.schedules.get(key));
  }
  return { version, offerings };
}

/** End of the schedule's last period that starts before t (t itself when t is a boundary). */
function endOfLastPeriodStartingBefore(schedule, t, ctx) {
  let end = -Infinity;
  for (const period of schedulePeriods(schedule, ctx.lo, ctx.hi)) {
    if (period.start < t && period.end > end) end = period.end;
  }
  if (end === -Infinity) throw new Error('enumeration window too small for a cutover');
  return end;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * Every owed period, one row per (buy, offering, period), and the same rows
 * grouped into obligations. Throws CoverageInputError (with .code and .detail
 * from error-codes.json) when the input cannot determine coverage.
 */
function expectedSubscriptionPeriods(input) {
  const now = instant(input.now, 'now');
  const versions = normalizeVersions(input);
  const offeringsById = new Map();
  for (const offering of input.offerings) {
    if (offeringsById.has(offering.offering_id)) throw new CoverageInputError('invalid_input', 'offering_id values must be unique');
    offeringsById.set(offering.offering_id, offering);
  }
  const chains = authorityChains(input);
  const windows = exceptionWindows(input.coverage);
  const inactive = inactiveWindows(input);

  // Enumeration window: everything the input mentions, with room for the longest period on either side.
  const mentioned = [now, ...versions.map(v => v.acceptedAt), ...chains.map(c => c.start)];
  for (const buy of input.buys) {
    mentioned.push(instant(buy.start_time, 'start_time'));
    if (buy.confirmed_at) mentioned.push(instant(buy.confirmed_at, 'confirmed_at'));
  }
  const longest = Math.max(DAY, ...input.offerings.map(o => {
    try {
      return parseDuration(o.schedule.period_duration).nominalMs;
    } catch {
      return DAY;
    }
  }));
  const margin = 2 * longest + 3 * DAY;
  const ctx = {
    input,
    versions,
    offeringsById,
    inactive,
    zonesUsed: new Set(),
    schedules: new Map(),
    lo: Math.min(...mentioned) - margin,
    hi: now + margin,
  };

  // Every instant at which the side can change.
  const changeSet = new Set(versions.map(v => v.acceptedAt));
  for (const window of inactive) {
    changeSet.add(window.from);
    if (Number.isFinite(window.until)) changeSet.add(window.until);
  }
  for (const offering of input.offerings) {
    if (offering.available_from !== undefined) changeSet.add(instant(offering.available_from, 'available_from'));
    if (offering.withdrawn_at !== undefined) changeSet.add(instant(offering.withdrawn_at, 'withdrawn_at'));
  }
  const changes = [...changeSet].filter(t => t <= ctx.hi).sort((a, b) => a - b);

  const rows = [];
  const seenBuys = new Set();
  for (const buy of input.buys) {
    if (seenBuys.has(buy.media_buy_id)) throw new CoverageInputError('invalid_input', 'media_buy_id values must be unique');
    seenBuys.add(buy.media_buy_id);
    // coverage: "Covered buys are the confirmed media buys in that account the caller can see"
    if (buy.confirmed_at === undefined || buy.confirmed_at === null) continue;
    const confirmedAt = instant(buy.confirmed_at, `${buy.media_buy_id}.confirmed_at`);
    const flightAt = flightTimeline(buy);

    const sides = changes.map(t => ({ t, side: sideAt(t, ctx, buy) }));
    const floors = []; // per side: Map offering_id -> first instant its periods may start
    sides.forEach(({ t, side }, index) => {
      floors.push(new Map());
      if (side === null) return;
      const previous = index > 0 ? sides[index - 1].side : null;
      for (const offeringId of side.offerings.keys()) {
        let floor;
        const reactivation = previous === null ? ctx.inactive.find(window => window.until === t) : undefined;
        const before = reactivation === undefined ? -1 : sides.findIndex(entry => entry.t >= reactivation.from) - 1;
        if (before >= 0 && sides[before].side !== null && sides[before].side.offerings.size > 0) {
          // coverage: "coverage resumes at the first boundary at or after the later of the reactivation instant and
          // the end of the last period owed before the deactivation", computed like a cutover's E at the
          // deactivation instant, so a schedule change made while inactive never owes a period twice.
          const last = sides[before].side;
          const lastEnd = id => Math.max(endOfLastPeriodStartingBefore(last.offerings.get(id), reactivation.from, ctx), floors[before].get(id));
          const end = last.offerings.has(offeringId) ? lastEnd(offeringId) : Math.max(...[...last.offerings.keys()].map(lastEnd));
          floor = Math.max(t, end);
        } else if (previous === null || previous.offerings.size === 0) {
          // "An incoming side with no outgoing predecessor, or whose predecessor resolved nothing, starts at T
          // under the ordinary start rule." Reactivation: "coverage resumes at the first boundary at or after
          // the reactivation instant". A period starts at or after the first boundary at or after T exactly
          // when it starts at or after T.
          floor = t;
        } else {
          // cutover: "the outgoing schedule owes its periods that start before T, in full; let E be the end of the
          // last of them ... the incoming schedule owes its periods that start at or after E". Per incoming
          // offering: its own E when it continues across T, otherwise the latest E across the outgoing offerings.
          // An outgoing side owes nothing before its own floor, so E never precedes that floor (the reading under
          // which "Nothing is owed twice" holds when two cutovers fall inside one period).
          const handoff = id => Math.max(endOfLastPeriodStartingBefore(previous.offerings.get(id), t, ctx), floors[index - 1].get(id));
          floor = previous.offerings.has(offeringId)
            ? handoff(offeringId)
            : Math.max(...[...previous.offerings.keys()].map(handoff));
        }
        floors[index].set(offeringId, floor);
      }
    });

    sides.forEach(({ side }, index) => {
      if (side === null) return;
      const until = index + 1 < sides.length ? sides[index + 1].t : Infinity;
      const previous = index > 0 ? sides[index - 1].side : null;
      const isCutover = previous !== null && previous.offerings.size > 0;
      for (const [offeringId, schedule] of side.offerings) {
        const floor = floors[index].get(offeringId);
        const periods = schedulePeriods(schedule, ctx.lo, ctx.hi).map(period => ({ ...period }));
        // cutover: "When the incoming side is a billing feed, that stretch is owed instead, as one stub period
        // [E, first incoming boundary after E) of the incoming schedule whose obligation carries stub true".
        if (isCutover && ctx.offeringsById.get(offeringId).feed_purpose === 'billing') {
          const next = periods.find(period => period.start >= floor);
          if (next !== undefined && next.start > floor) periods.push({ start: floor, end: next.start, stub: true });
        }
        periods.sort((a, b) => a.start - b.start);
        for (const period of periods) {
          const owed =
            period.start >= floor && period.start < until && // cutover: owned by this side
            period.start < period.end && // "A period whose start and end coincide ... is never owed"
            period.end <= now && // only resolved periods
            authorized(chains, period, input.backfill_on_regrant === true) &&
            period.end > confirmedAt && // "that end after the buy's confirmed_at"
            overlapsFlight(period, flightAt(period.end)) && // "scope_resolved_at is the period end"
            !excepted(windows, buy.media_buy_id, offeringId, period);
          if (owed) {
            rows.push({
              subscription_version: side.version.number,
              media_buy_id: buy.media_buy_id,
              offering_id: offeringId,
              start: period.start,
              end: period.end,
              ...(period.stub ? { stub: true } : {}),
            });
          }
        }
      }
    });
  }

  rows.sort((a, b) =>
    a.start - b.start || a.subscription_version - b.subscription_version ||
    byteCompare(a.offering_id, b.offering_id) || byteCompare(a.media_buy_id, b.media_buy_id));
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.subscription_version, row.offering_id, row.start, row.end]);
    if (!groups.has(key)) groups.set(key, { ...row, media_buy_ids: [] });
    groups.get(key).media_buy_ids.push(row.media_buy_id);
  }
  return {
    expected: rows.map(row => ({
      subscription_version: row.subscription_version,
      media_buy_id: row.media_buy_id,
      offering_id: row.offering_id,
      period_start: format(row.start),
      period_end: format(row.end),
      ...(row.stub ? { stub: true } : {}),
    })),
    expected_obligations: [...groups.values()].map(group => ({
      subscription_version: group.subscription_version,
      offering_id: group.offering_id,
      period_start: format(group.start),
      period_end: format(group.end),
      ...(group.stub ? { stub: true } : {}),
      media_buy_ids: [...new Set(group.media_buy_ids)].sort(byteCompare),
    })),
    timezones: [...ctx.zonesUsed].sort(),
  };
}

module.exports = { expectedSubscriptionPeriods, CoverageInputError, instant, format, byteCompare };
