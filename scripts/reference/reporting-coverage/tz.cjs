'use strict';

/**
 * A minimal, independent IANA time zone evaluator for the reporting-coverage
 * reference model.
 *
 * It reads the zic source lines (Zone, Rule, Link) of a pinned tzdata release
 * from tzdata.json and computes each zone's UTC offset transitions itself. It
 * does not touch ICU, Intl, Temporal, TZif files, or the host's zoneinfo, so
 * it shares no time zone code or compiled data with either SDK (the TypeScript
 * SDK uses Intl, backed by ICU; the Python SDK uses zoneinfo, backed by TZif
 * files). Only the published IANA source text is shared, which is the point:
 * the vectors pin the release.
 *
 * It implements the subset of zic(8) the pinned zones use: Zone continuation
 * lines with UNTIL, Rule lines with FROM/TO/IN/ON/AT/SAVE (ON as a day, lastDay,
 * Day>=N, Day<=N; AT with w/s/u suffixes), fixed-save RULES fields, and Links.
 * Years 1800 to 2200 are expanded; nothing the vectors use is near either end.
 *
 * All instants are integer milliseconds since 1970-01-01T00:00:00Z. A "wall"
 * value is the local civil date and time encoded the same way, as if it were UTC.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'tzdata.json'), 'utf8'));
const NAMES = new Set(DATA.names);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIN_YEAR = 1800;
const MAX_YEAR = 2200;
const SECOND = 1000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Proleptic Gregorian calendar arithmetic (days since 1970-01-01)
// ---------------------------------------------------------------------------

function daysFromCivil(year, month, day) {
  // month 1..12. Howard Hinnant's days_from_civil.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function daysInMonth(year, month) {
  return daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - daysFromCivil(year, month, 1);
}

/** 0 = Sunday. 1970-01-01 was a Thursday. */
function weekday(days) {
  return (((days + 4) % 7) + 7) % 7;
}

// ---------------------------------------------------------------------------
// zic field parsing
// ---------------------------------------------------------------------------

/** "2", "2:00", "-1:30", "24:00", "0:00s", "4:00u", "-" -> { ms, suffix }. */
function parseTime(field) {
  if (field === '-') return { ms: 0, suffix: 'w' };
  const match = /^(-)?(\d+)(?::(\d+))?(?::(\d+))?([wsugzd]?)$/.exec(field);
  if (!match) throw new Error(`unsupported zic time ${JSON.stringify(field)}`);
  const ms = ((Number(match[2]) * 60 + Number(match[3] || 0)) * 60 + Number(match[4] || 0)) * SECOND;
  const suffix = { '': 'w', w: 'w', s: 's', u: 'u', g: 'u', z: 'u', d: 'w' }[match[5]];
  return { ms: match[1] ? -ms : ms, suffix };
}

function parseMonth(field) {
  const index = MONTHS.findIndex(name => name.toLowerCase() === field.slice(0, 3).toLowerCase());
  if (index < 0) throw new Error(`unsupported zic month ${JSON.stringify(field)}`);
  return index + 1;
}

/** ON field -> day of month in (year, month). */
function resolveOn(field, year, month) {
  if (/^\d+$/.test(field)) return Number(field);
  const last = /^last(\w{3})$/.exec(field);
  if (last) {
    const wd = WEEKDAYS.indexOf(last[1]);
    let day = daysInMonth(year, month);
    while (weekday(daysFromCivil(year, month, day)) !== wd) day -= 1;
    return day;
  }
  const rel = /^(\w{3})([<>]=)(\d+)$/.exec(field);
  if (rel) {
    const wd = WEEKDAYS.indexOf(rel[1]);
    let day = Number(rel[3]);
    const step = rel[2] === '>=' ? 1 : -1;
    while (weekday(daysFromCivil(year, month, day)) !== wd) day += step;
    return day;
  }
  throw new Error(`unsupported zic ON ${JSON.stringify(field)}`);
}

function parseRule(line) {
  const f = line.trim().split(/\s+/);
  const from = f[2] === 'min' ? MIN_YEAR : Number(f[2]);
  const to = f[3] === 'only' ? from : f[3] === 'max' ? MAX_YEAR : Number(f[3]);
  return { from, to, month: parseMonth(f[5]), on: f[6], at: parseTime(f[7]), save: parseTime(f[8]).ms };
}

function parseEra(line) {
  const f = line.trim().split(/\s+/);
  const fields = f[0] === 'Zone' ? f.slice(2) : f;
  const [stdoff, rules, , ...until] = fields;
  let ruleSet;
  if (rules === '-') ruleSet = { fixed: 0 };
  else if (/^-?\d/.test(rules)) ruleSet = { fixed: parseTime(rules).ms };
  else ruleSet = { name: rules };
  let untilSpec = null;
  if (until.length > 0) {
    untilSpec = {
      year: Number(until[0]),
      month: until[1] ? parseMonth(until[1]) : 1,
      on: until[2] || '1',
      time: until[3] ? parseTime(until[3]) : { ms: 0, suffix: 'w' },
    };
  }
  return { stdoff: parseTime(stdoff).ms, ruleSet, until: untilSpec };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Rule transitions of one rule set under one standard offset, in order. */
function ruleTransitions(ruleName, stdoff) {
  const lines = DATA.rules[ruleName];
  if (!lines) throw new Error(`rule ${ruleName} is not in the pinned tzdata subset`);
  const raw = [];
  for (const rule of lines.map(parseRule)) {
    for (let year = Math.max(rule.from, MIN_YEAR); year <= Math.min(rule.to, MAX_YEAR); year += 1) {
      const day = resolveOn(rule.on, year, rule.month);
      raw.push({ local: daysFromCivil(year, rule.month, day) * DAY + rule.at.ms, suffix: rule.at.suffix, save: rule.save });
    }
  }
  raw.sort((a, b) => a.local - b.local);
  const out = [];
  let savePrev = 0;
  for (const entry of raw) {
    let at = entry.local;
    if (entry.suffix === 's') at -= stdoff;
    else if (entry.suffix === 'w') at -= stdoff + savePrev;
    // The wall clock reading at which the transition happens, before it does.
    out.push({ at, wall: at + stdoff + savePrev, save: entry.save });
    savePrev = entry.save;
  }
  return out;
}

function saveAt(list, instant) {
  let save = 0;
  for (const entry of list) {
    if (entry.at <= instant) save = entry.save;
    else break;
  }
  return save;
}

const zoneCache = new Map();

/** Resolve a link chain to its zone name. */
function canonicalZone(name) {
  let target = name;
  const seen = new Set();
  while (DATA.links[target] !== undefined) {
    if (seen.has(target)) throw new Error(`link cycle at ${target}`);
    seen.add(target);
    target = DATA.links[target];
  }
  return target;
}

/** Ordered { at, offset } changes; the first entry's at is -Infinity. */
function transitions(name) {
  const zone = canonicalZone(name);
  if (zoneCache.has(zone)) return zoneCache.get(zone);
  const lines = DATA.zones[zone];
  if (!lines) throw new Error(`${name} is not in the pinned tzdata subset`);
  const out = [];
  let eraStart = -Infinity;
  for (const era of lines.map(parseEra)) {
    const rules = era.ruleSet.name ? ruleTransitions(era.ruleSet.name, era.stdoff) : null;
    const save = instant => (rules ? saveAt(rules, instant) : era.ruleSet.fixed);
    let eraEnd = Infinity;
    if (era.until) {
      const { year, month, on, time } = era.until;
      const local = daysFromCivil(year, month, resolveOn(on, year, month)) * DAY + time.ms;
      if (time.suffix === 'u') eraEnd = local;
      else if (time.suffix === 's') eraEnd = local - era.stdoff;
      else {
        // Wall time: the save in effect just before the UNTIL instant.
        let guess = local - era.stdoff - save(local - era.stdoff);
        guess = local - era.stdoff - save(guess - 1);
        eraEnd = guess;
      }
    }
    const push = (at, offset) => {
      if (out.length === 0 || out[out.length - 1].offset !== offset) out.push({ at, offset });
    };
    if (!rules) push(eraStart, era.stdoff + era.ruleSet.fixed);
    else {
      // As zic does, a rule transition whose wall time is at or before the
      // era's starting wall time is already in effect when the era starts.
      const startWall = eraStart + (out.length > 0 ? out[out.length - 1].offset : era.stdoff);
      let first = -1;
      rules.forEach((entry, index) => {
        if (entry.at <= eraStart || entry.wall <= startWall) first = index;
      });
      push(eraStart, era.stdoff + (first >= 0 ? rules[first].save : 0));
      for (let index = first + 1; index < rules.length; index += 1) {
        if (rules[index].at < eraEnd) push(rules[index].at, era.stdoff + rules[index].save);
      }
    }
    eraStart = eraEnd;
  }
  zoneCache.set(zone, out);
  return out;
}

/** UTC offset in milliseconds in effect at an instant. */
function offsetAt(name, instant) {
  const list = transitions(name);
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].at <= instant) lo = mid;
    else hi = mid - 1;
  }
  return list[lo].offset;
}

/** Local wall value at an instant. */
function toWall(name, instant) {
  return instant + offsetAt(name, instant);
}

/** Every instant whose local wall value is `wall`, ascending: none in a gap, two in a fold. */
function wallInstants(name, wall) {
  const list = transitions(name);
  const offsets = new Set([offsetAt(name, wall - 2 * DAY)]);
  for (const entry of list) {
    if (entry.at > wall - 2 * DAY && entry.at < wall + 2 * DAY) offsets.add(entry.offset);
  }
  return [...offsets]
    .map(offset => wall - offset)
    .filter(instant => offsetAt(name, instant) === wall - instant)
    .sort((a, b) => a - b);
}

/**
 * reporting-schedule.json period_generation: an ambiguous local time uses the
 * earlier offset (the earlier instant); a nonexistent one advances by the gap,
 * which is the wall value read with the offset in effect before the gap.
 */
function resolveWall(name, wall) {
  const found = wallInstants(name, wall);
  if (found.length > 0) return found[0];
  const list = transitions(name);
  for (let index = 1; index < list.length; index += 1) {
    const { at, offset: after } = list[index];
    const before = list[index - 1].offset;
    if (at + before <= wall && wall < at + after) return wall - before;
  }
  throw new Error(`no instant for wall time ${new Date(wall).toISOString()} in ${name}`);
}

/** A recognized IANA zone or link name in the pinned release. */
function isIanaName(name) {
  return typeof name === 'string' && NAMES.has(name);
}

/** The pinned subset carries this zone's rules. */
function hasZone(name) {
  return isIanaName(name) && DATA.zones[canonicalZone(name)] !== undefined;
}

module.exports = {
  TZDATA_VERSION: DATA.version,
  TZDATA_SOURCE: DATA.source,
  TZDATA_SHA512: DATA.source_sha512,
  DAY,
  daysFromCivil,
  civilFromDays,
  daysInMonth,
  weekday,
  transitions,
  offsetAt,
  toWall,
  wallInstants,
  resolveWall,
  isIanaName,
  hasZone,
  canonicalZone,
};
