'use strict';

/**
 * The three coverage implementations under differential test, behind one
 * batch interface. Each result is
 *   { ok: true, rows, obligations } | { ok: false, error: { kind, code, detail, message } }.
 *
 *   reference  scripts/reference/reporting-coverage (in process)
 *   ts         @adcp/sdk owedSubscriptionPeriodsV1 (cli-ts.mjs --lines)
 *   py         adcp owed_subscription_periods (cli_py.py --lines)
 *
 * The SDK CLIs run as persistent line-mode workers, so the Python SDK's import
 * cost is paid once per run, not once per batch.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const env = require('../lib/env.cjs');

const { expectedSubscriptionPeriods, CoverageInputError } = require(path.join(env.ROOT, 'scripts/reference/reporting-coverage/coverage.cjs'));

function referenceOne(input) {
  try {
    const result = expectedSubscriptionPeriods(structuredClone(input));
    return { ok: true, rows: result.expected, obligations: result.expected_obligations, timezones: result.timezones };
  } catch (error) {
    if (error instanceof CoverageInputError || /^COVERAGE_INPUT_/.test(error?.code ?? '')) {
      return { ok: false, error: { kind: 'coverage_input', code: error.code, detail: error.detail, message: error.message } };
    }
    return { ok: false, error: { kind: 'crash', code: error?.code ?? null, detail: error?.name ?? null, message: String(error?.message ?? error) } };
  }
}

class Worker {
  constructor(name, command, args) {
    this.name = name;
    this.child = spawn(command, [...args, '--lines'], { env: env.childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-20_000);
    });
    this.waiting = [];
    this.exited = null;
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      const next = this.waiting.shift();
      if (next) next.resolve(line);
    });
    this.child.on('exit', code => {
      this.exited = code;
      for (const pending of this.waiting.splice(0)) pending.reject(new Error(`${name} worker exited ${code}: ${this.stderr}`));
    });
  }

  run(inputs) {
    if (this.exited !== null) return Promise.reject(new Error(`${this.name} worker exited ${this.exited}: ${this.stderr}`));
    return new Promise((resolve, reject) => {
      this.waiting.push({
        resolve: line => {
          const results = JSON.parse(line);
          if (!Array.isArray(results) || results.length !== inputs.length) reject(new Error(`${this.name}: expected ${inputs.length} results`));
          else resolve(results);
        },
        reject,
      });
      this.child.stdin.write(`${JSON.stringify(inputs)}\n`);
    });
  }

  close() {
    if (this.exited === null) this.child.stdin.end();
  }
}

/** Starts the SDK workers; returns { run(inputs, names?) -> { name: results[] }, close() }. */
function startImplementations(names = ['reference', 'ts', 'py']) {
  const workers = {};
  if (names.includes('ts')) workers.ts = new Worker('ts', process.execPath, [path.join(__dirname, 'cli-ts.mjs')]);
  if (names.includes('py')) workers.py = new Worker('py', env.PYTHON, ['-I', path.join(__dirname, 'cli_py.py')]);
  return {
    names,
    async run(inputs, subset = names) {
      const out = {};
      const pending = subset.filter(name => name !== 'reference').map(async name => {
        out[name] = await workers[name].run(inputs);
      });
      if (subset.includes('reference')) out.reference = inputs.map(referenceOne);
      await Promise.all(pending);
      // Keep a stable key order: reference, ts, py.
      return Object.fromEntries(names.filter(name => subset.includes(name)).map(name => [name, out[name]]));
    },
    close() {
      for (const worker of Object.values(workers)) worker.close();
    },
  };
}

/**
 * How two results disagree, as { kind, detail }, or null. Errors compare by
 * code and detail, never by message; a crash agrees only with a crash.
 */
function difference(a, b) {
  if (a.ok !== b.ok) {
    const [okSide, errSide] = a.ok ? ['first', b] : ['second', a];
    return { kind: 'ok_vs_error', detail: `${okSide} ok, other ${errSide.error.kind} ${errSide.error.code}/${errSide.error.detail}` };
  }
  if (!a.ok) {
    if (a.error.kind === 'crash' || b.error.kind === 'crash') {
      return a.error.kind === b.error.kind ? null : { kind: 'error_vs_error', detail: `${a.error.kind} vs ${b.error.kind}` };
    }
    return a.error.code === b.error.code && a.error.detail === b.error.detail
      ? null
      : { kind: 'error_vs_error', detail: `${a.error.code}/${a.error.detail} vs ${b.error.code}/${b.error.detail}` };
  }
  const rowsA = a.rows.map(row => JSON.stringify(row));
  const rowsB = b.rows.map(row => JSON.stringify(row));
  if (rowsA.join('\n') !== rowsB.join('\n')) {
    const setA = new Set(rowsA);
    const setB = new Set(rowsB);
    const onlyA = rowsA.filter(row => !setB.has(row));
    const onlyB = rowsB.filter(row => !setA.has(row));
    if (onlyA.length === 0 && onlyB.length === 0) return { kind: 'order', detail: 'same rows, different order' };
    return { kind: 'rows', detail: `${onlyA.length} rows only in first, ${onlyB.length} only in second`, onlyA, onlyB };
  }
  if (JSON.stringify(a.obligations) !== JSON.stringify(b.obligations)) return { kind: 'obligations', detail: 'same rows, different obligations' };
  return null;
}

/** Pairwise disagreements among the implementations' results for one scenario. */
function disagreements(byName) {
  const names = Object.keys(byName);
  const out = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const diff = difference(byName[names[i]], byName[names[j]]);
      if (diff) out.push({ pair: `${names[i]}~${names[j]}`, ...diff });
    }
  }
  return out;
}

/** Which implementations stand apart: for three, the odd one out when two agree. */
function partition(byName) {
  const names = Object.keys(byName);
  const groups = [];
  for (const name of names) {
    const group = groups.find(g => difference(byName[g[0]], byName[name]) === null);
    if (group) group.push(name);
    else groups.push([name]);
  }
  return groups;
}

/** A stable signature of how a scenario disagrees, used to dedupe and to guide minimization. */
function signature(byName) {
  const groups = partition(byName);
  if (groups.length === 1) return null;
  const outcome = result => (result.ok ? 'ok' : result.error.kind === 'crash' ? 'crash' : `${result.error.code}/${result.error.detail}`);
  return groups.map(group => `${group.join('+')}(${outcome(byName[group[0]])})`).join(' | ');
}

module.exports = { startImplementations, referenceOne, difference, disagreements, partition, signature };
