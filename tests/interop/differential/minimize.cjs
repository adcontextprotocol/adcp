'use strict';

/**
 * Greedy scenario minimizer. Given an input on which the implementations
 * disagree, it repeatedly applies the first reduction that keeps the same
 * disagreement signature (implementations.cjs signature), until none does.
 * Every candidate must still be a valid buyer input (validate.cjs), unless the
 * original was not one (an "invalid" flavor scenario).
 *
 * Reductions, largest first: move `now` earlier, drop a buy, a version, a
 * grant, an offering, a package, a coverage entry, a flight edit, drop
 * optional fields, and shorten flights.
 */

const path = require('node:path');
const env = require('../lib/env.cjs');
const { validateInput } = require('./validate.cjs');
const { signature } = require('./implementations.cjs');

const { format: iso } = require(path.join(env.ROOT, 'scripts/reference/reporting-coverage/coverage.cjs'));
const clone = value => structuredClone(value);
const ms = text => Date.parse(text);

function dropOffering(input, id) {
  const next = clone(input);
  next.offerings = next.offerings.filter(o => o.offering_id !== id);
  for (const buy of next.buys) {
    for (const pkg of buy.packages) pkg.reporting_delivery_offering_ids = pkg.reporting_delivery_offering_ids.filter(x => x !== id);
  }
  if (next.coverage) {
    for (const key of ['excluded', 'gaps', 'timezone_cutovers']) {
      if (next.coverage[key]) next.coverage[key] = next.coverage[key].filter(entry => entry.offering_id !== id);
    }
  }
  return next;
}

function tidy(input) {
  if (input.coverage) {
    for (const key of Object.keys(input.coverage)) if (input.coverage[key].length === 0) delete input.coverage[key];
    if (Object.keys(input.coverage).length === 0) delete input.coverage;
  }
  if (input.inactive_intervals && input.inactive_intervals.length === 0) delete input.inactive_intervals;
  return input;
}

/** Candidate reductions of an input, largest first. `results` are the current results, for `now` targets. */
function* reductions(input, results) {
  // now: the earliest period end any implementation reports, then halving.
  const ends = new Set();
  for (const result of Object.values(results)) if (result.ok) for (const row of result.rows) ends.add(ms(row.period_end));
  const now = ms(input.now);
  const targets = [...ends].filter(t => t < now).sort((a, b) => a - b);
  for (const t of targets.slice(0, 6)) yield { what: `now -> ${iso(t)}`, input: { ...clone(input), now: iso(t) } };
  // buys
  if (input.buys.length > 1) {
    for (let i = 0; i < input.buys.length; i += 1) {
      const next = clone(input);
      const [removed] = next.buys.splice(i, 1);
      if (next.coverage?.excluded) next.coverage.excluded = next.coverage.excluded.filter(e => e.media_buy_id !== removed.media_buy_id);
      yield { what: `drop buy ${removed.media_buy_id}`, input: tidy(next) };
    }
  }
  // versions: the last, or the first (the next one then starts the history)
  if (input.versions.length > 1) {
    const last = clone(input);
    last.versions.pop();
    delete last.versions[last.versions.length - 1].superseded_at;
    yield { what: 'drop last version', input: last };
    const first = clone(input);
    first.versions.shift();
    yield { what: 'drop first version', input: first };
    for (let i = 1; i < input.versions.length - 1; i += 1) {
      const middle = clone(input);
      middle.versions.splice(i, 1);
      if (middle.versions[i - 1].superseded_at) middle.versions[i - 1].superseded_at = middle.versions[i].accepted_at;
      yield { what: `drop version ${input.versions[i].subscription_version}`, input: middle };
    }
  }
  // grants
  if (input.account.grants.length > 1) {
    const last = clone(input);
    last.account.grants.pop();
    delete last.account.grants[last.account.grants.length - 1].unauthorized_at;
    yield { what: 'drop last grant', input: last };
    const first = clone(input);
    first.account.grants.shift();
    yield { what: 'drop first grant', input: first };
  }
  // offerings
  if (input.offerings.length > 1) {
    for (const offering of input.offerings) yield { what: `drop offering ${offering.offering_id}`, input: tidy(dropOffering(input, offering.offering_id)) };
  }
  // packages and their offering lists
  for (let b = 0; b < input.buys.length; b += 1) {
    const buy = input.buys[b];
    if (buy.packages.length > 1) {
      for (let p = 0; p < buy.packages.length; p += 1) {
        const next = clone(input);
        next.buys[b].packages.splice(p, 1);
        yield { what: `drop ${buy.media_buy_id}/${buy.packages[p].package_id}`, input: next };
      }
    }
    for (let p = 0; p < buy.packages.length; p += 1) {
      const ids = buy.packages[p].reporting_delivery_offering_ids;
      for (let k = 0; k < ids.length; k += 1) {
        const next = clone(input);
        next.buys[b].packages[p].reporting_delivery_offering_ids.splice(k, 1);
        yield { what: `drop ${ids[k]} from ${buy.media_buy_id}/${buy.packages[p].package_id}`, input: next };
      }
    }
  }
  // coverage entries
  for (const key of ['excluded', 'gaps', 'timezone_cutovers']) {
    for (let i = 0; i < (input.coverage?.[key]?.length ?? 0); i += 1) {
      const next = clone(input);
      next.coverage[key].splice(i, 1);
      yield { what: `drop coverage.${key}[${i}]`, input: tidy(next) };
    }
  }
  // flight history
  for (let b = 0; b < input.buys.length; b += 1) {
    const history = input.buys[b].flight_history ?? [];
    for (let i = 0; i < history.length; i += 1) {
      const next = clone(input);
      next.buys[b].flight_history.splice(i, 1);
      if (next.buys[b].flight_history.length === 0) delete next.buys[b].flight_history;
      yield { what: `drop ${input.buys[b].media_buy_id}.flight_history[${i}]`, input: next };
    }
  }
  // optional fields
  const optional = [
    ['backfill_on_regrant'],
    ['status_retention_days'],
    ['inactive_intervals'],
    ['account', 'operator'],
    ['account', 'source_timezone'],
  ];
  for (const fieldPath of optional) {
    const next = clone(input);
    let target = next;
    for (const key of fieldPath.slice(0, -1)) target = target[key];
    if (target[fieldPath[fieldPath.length - 1]] !== undefined) {
      delete target[fieldPath[fieldPath.length - 1]];
      yield { what: `drop ${fieldPath.join('.')}`, input: next };
    }
  }
  for (let b = 0; b < input.buys.length; b += 1) {
    for (const key of ['cancellation_effective_at', 'canceled_at', 'completed_at']) {
      if (input.buys[b][key] === undefined) continue;
      const next = clone(input);
      delete next.buys[b][key];
      if (key === 'canceled_at') delete next.buys[b].cancellation_effective_at;
      yield { what: `drop ${input.buys[b].media_buy_id}.${key}`, input: next };
    }
  }
  for (let o = 0; o < input.offerings.length; o += 1) {
    for (const key of ['available_from', 'withdrawn_at', 'unmapped_dimensions']) {
      if (input.offerings[o][key] === undefined) continue;
      const next = clone(input);
      delete next.offerings[o][key];
      yield { what: `drop ${input.offerings[o].offering_id}.${key}`, input: next };
    }
  }
  for (let v = 0; v < input.versions.length; v += 1) {
    const version = input.versions[v];
    if (version.superseded_at !== undefined) {
      const next = clone(input);
      delete next.versions[v].superseded_at;
      yield { what: `drop v${version.subscription_version}.superseded_at`, input: next };
    }
    for (const key of ['alignment', 'match', 'period_timezone']) {
      if (version.configuration.selector[key] === undefined) continue;
      const next = clone(input);
      delete next.versions[v].configuration.selector[key];
      yield { what: `drop v${version.subscription_version}.selector.${key}`, input: next };
    }
    for (const key of ['exclude_account_ids', 'operator_domains']) {
      if (version.configuration[key] === undefined) continue;
      const next = clone(input);
      delete next.versions[v].configuration[key];
      yield { what: `drop v${version.subscription_version}.${key}`, input: next };
    }
  }
  // shorten flights
  for (let b = 0; b < input.buys.length; b += 1) {
    const start = ms(input.buys[b].start_time);
    const end = ms(input.buys[b].end_time);
    if (end - start > 3_600_000) {
      const next = clone(input);
      next.buys[b].end_time = iso(start + Math.round((end - start) / 2 / 3_600_000) * 3_600_000);
      yield { what: `halve ${input.buys[b].media_buy_id} flight`, input: next };
    }
  }
}

/**
 * Minimize `input` while `impls.run` keeps the same disagreement signature.
 * Returns { input, results, steps }.
 */
async function minimize(impls, input, { maxRounds = 60, batch = 48, allowWireInvalid = false, log = () => {} } = {}) {
  let current = clone(input);
  let results = await impls.run([current]).then(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v[0]])));
  const target = signature(results);
  if (!target) return { input: current, results, steps: [] };
  const steps = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const candidates = [];
    for (const candidate of reductions(current, results)) {
      if (!allowWireInvalid && validateInput(candidate.input).length) continue;
      candidates.push(candidate);
    }
    let accepted = null;
    for (let i = 0; i < candidates.length && !accepted; i += batch) {
      const slice = candidates.slice(i, i + batch);
      const out = await impls.run(slice.map(c => c.input));
      for (let k = 0; k < slice.length; k += 1) {
        const byName = Object.fromEntries(Object.entries(out).map(([name, list]) => [name, list[k]]));
        if (signature(byName) === target) {
          accepted = { ...slice[k], results: byName };
          break;
        }
      }
    }
    if (!accepted) break;
    current = accepted.input;
    results = accepted.results;
    steps.push(accepted.what);
    log(`  minimize: ${accepted.what}`);
  }
  return { input: current, results, steps, signature: target };
}

module.exports = { minimize, reductions };
