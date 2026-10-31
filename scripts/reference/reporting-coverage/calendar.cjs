'use strict';

/**
 * Period boundaries, from core/reporting-schedule.json x-adcp-validation
 * period_generation, enumerated by brute force.
 *
 * Two generators, one per paragraph of the rule:
 *
 * - Ordinal schedules. Boundary n is computed directly from the origin and n:
 *   add n x (years and months) to the origin's local year and month, keeping
 *   the origin's day clamped to the target month's last day; add n x days to
 *   the civil date; put the origin's local time of day on it and resolve that
 *   wall time in the zone (a gap advances by the gap, a fold takes the earlier
 *   offset); then add n x (hours, minutes, seconds) as exact elapsed time.
 *   utc alignment is this in Etc/UTC from 1970-01-01T00:00:00.
 * - Sub-daily local schedules (account_timezone, source_timezone, or
 *   billing_cycle with a duration of only hours, minutes, and seconds that
 *   divides 24 hours). For every local date, every wall time that is a whole
 *   multiple of the duration after local midnight, read in the zone: a wall
 *   time that does not exist yields no boundary, a repeated one yields one
 *   boundary per offset.
 *
 * Periods are consecutive boundaries. A period whose start equals its end has
 * zero length; the coverage model never owes it.
 */

const tz = require('./tz.cjs');

const HOUR = 3_600_000;
const DAY = tz.DAY;

/**
 * An input that cannot determine coverage. code is the frozen error code from
 * static/compliance/source/test-vectors/reporting-subscriptions/error-codes.json
 * (COVERAGE_INPUT_INCOMPLETE for a missing value, COVERAGE_INPUT_INVALID for a
 * malformed one); detail names the cause from that code's details.
 */
class CoverageInputError extends Error {
  constructor(detail, message) {
    super(`${detail}: ${message}`);
    this.detail = detail;
    this.code = detail.startsWith('missing_') ? 'COVERAGE_INPUT_INCOMPLETE' : 'COVERAGE_INPUT_INVALID';
    this.recovery = 'correctable';
  }
}

/**
 * The schedule pattern from core/reporting-schedule.json: Y, M, D, then T with
 * H, M, S; at least one non-zero component. There is no W designator.
 */
const DURATION = /^P(?=.*[1-9])(?=\d|T)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function parseDuration(text) {
  const match = typeof text === 'string' ? DURATION.exec(text) : null;
  if (!match) throw new CoverageInputError('invalid_period_duration', `${JSON.stringify(text)} is not a schedule period_duration`);
  const [years, months, days, hours, minutes, seconds] = match.slice(1).map(value => Number(value || 0));
  return {
    text,
    years,
    months,
    days,
    timeMs: ((hours * 60 + minutes) * 60 + seconds) * 1000,
    hasDate: years + months + days > 0,
    hasTime: hours + minutes + seconds > 0,
    nominalMs: years * 365.2425 * DAY + months * 30.436875 * DAY + days * DAY + ((hours * 60 + minutes) * 60 + seconds) * 1000,
  };
}

function wallFields(wall) {
  const days = Math.floor(wall / DAY);
  return { ...tz.civilFromDays(days), timeOfDay: wall - days * DAY };
}

/**
 * A schedule. zone is an IANA name (Etc/UTC for utc alignment); originWall is
 * the local civil origin. local is true for the three local alignments.
 */
function createCalendar({ duration, zone, originWall, local }) {
  const d = parseDuration(duration);
  if (local && d.hasDate && d.hasTime) {
    throw new CoverageInputError('invalid_period_duration', `${duration} mixes date and time components under a local alignment`);
  }
  const subDaily = local && !d.hasDate;
  if (subDaily && DAY % d.timeMs !== 0) {
    throw new CoverageInputError('invalid_period_duration', `${duration} does not divide 24 hours`);
  }
  const key = JSON.stringify([d.text, zone, subDaily ? null : originWall, local]);
  const cache = new Map();

  function ordinalBoundary(n) {
    const o = wallFields(originWall);
    const monthIndex = o.year * 12 + (o.month - 1) + n * (d.years * 12 + d.months);
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex - year * 12 + 1;
    const day = Math.min(o.day, tz.daysInMonth(year, month));
    const dateDays = tz.daysFromCivil(year, month, day) + n * d.days;
    const instant = tz.resolveWall(zone, dateDays * DAY + o.timeOfDay);
    return instant + n * d.timeMs;
  }

  function ordinalBoundaries(lo, hi) {
    const origin = ordinalBoundary(0);
    let n0 = Math.floor((lo - origin) / d.nominalMs) - 2;
    while (ordinalBoundary(n0) > lo) n0 -= 1;
    let n1 = Math.ceil((hi - origin) / d.nominalMs) + 2;
    while (ordinalBoundary(n1) < hi) n1 += 1;
    const out = [];
    for (let n = n0; n <= n1; n += 1) out.push(ordinalBoundary(n));
    return out;
  }

  function subDailyBoundaries(lo, hi) {
    const firstDay = Math.floor((lo - 2 * DAY) / DAY) - 1;
    const lastDay = Math.floor((hi + 2 * DAY) / DAY) + 1;
    const found = new Set();
    for (let dayIndex = firstDay; dayIndex <= lastDay; dayIndex += 1) {
      for (let offset = 0; offset < DAY; offset += d.timeMs) {
        for (const instant of tz.wallInstants(zone, dayIndex * DAY + offset)) found.add(instant);
      }
    }
    return [...found].sort((a, b) => a - b);
  }

  /** Every period [start, end) with start <= hi and end >= lo, ascending, zero-length ones included. */
  function periods(lo, hi) {
    const cacheKey = `${lo}:${hi}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const boundaries = subDaily ? subDailyBoundaries(lo, hi) : ordinalBoundaries(lo, hi);
    for (let i = 1; i < boundaries.length; i += 1) {
      if (boundaries[i] < boundaries[i - 1]) throw new Error(`boundaries out of order in ${key}`);
    }
    const out = [];
    for (let i = 1; i < boundaries.length; i += 1) {
      const start = boundaries[i - 1];
      const end = boundaries[i];
      if (start <= hi && end >= lo) out.push({ start, end });
    }
    cache.set(cacheKey, out);
    return out;
  }

  return { key, duration: d, zone, subDaily, periods, ordinalBoundary: subDaily ? null : ordinalBoundary };
}

/** utc alignment: 1970-01-01T00:00:00Z is interval zero. */
function utcCalendar(duration) {
  return createCalendar({ duration, zone: 'Etc/UTC', originWall: 0, local: false });
}

/** account_timezone and source_timezone: local midnight on 1970-01-01 in the zone. */
function localCalendar(duration, zone) {
  return createCalendar({ duration, zone, originWall: 0, local: true });
}

/** billing_cycle: the anchor instant expressed in the zone. */
function billingCalendar(duration, zone, anchor) {
  return createCalendar({ duration, zone, originWall: tz.toWall(zone, anchor), local: true });
}

module.exports = { CoverageInputError, parseDuration, createCalendar, utcCalendar, localCalendar, billingCalendar, HOUR, DAY };
