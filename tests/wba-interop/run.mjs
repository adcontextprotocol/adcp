#!/usr/bin/env node
/**
 * Grades a Web Bot Auth implementation against the judge (judge.mjs), through
 * the adapter protocol in PROTOCOL.md.
 *
 *   node tests/wba-interop/run.mjs --adapter "<command>" [--vectors <dir>] [--junit <file>]
 *   node tests/wba-interop/run.mjs --self [--junit <file>]
 *
 * With --adapter, the harness grades the adapter's signer and verifier:
 *
 * - vectors: the committed request and directory vectors, at their reference_now.
 * - live: the adapter signs and the judge verifies, then the judge signs and the
 *   adapter verifies, at the wall-clock time.
 * - scenarios: the judge signs every scenario in scenarios.json at the
 *   wall-clock time, and the adapter verifies it.
 *
 * With --self, the adapter is judge.mjs itself, and the harness also checks each
 * scenario's tier: a "wba" scenario gets its expected outcome from the bare
 * library, and an "adcp" scenario gets the opposite outcome from the bare
 * library and the expected one from the policy.
 *
 * The exit code is 1 when any check fails.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as judge from './judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    adapter: { type: 'string' },
    self: { type: 'boolean', default: false },
    vectors: { type: 'string', default: join(HERE, '../../static/compliance/source/test-vectors/wba-profile') },
    junit: { type: 'string' },
  },
});
if (!args.self && !args.adapter) {
  console.error('usage: run.mjs --adapter "<command>" | --self [--vectors <dir>] [--junit <file>]');
  process.exit(2);
}
const command = args.self ? `"${process.execPath}" "${join(HERE, 'judge.mjs')}"` : args.adapter;

// An adapter that does not exit 0 with one JSON object on its standard output has crashed.
function adapter(op) {
  const r = spawnSync(command, { shell: true, input: JSON.stringify(op), encoding: 'utf8', maxBuffer: 1 << 24 });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  if (r.status === 0 && out !== null && typeof out === 'object') return out;
  return { ok: false, status: 0, rule: 'adapter-crash', error: (r.stderr || r.stdout || String(r.error ?? `exit ${r.status ?? r.signal}`)).slice(0, 600) };
}

// ── Data ──────────────────────────────────────────────────────────────────

const read = path => JSON.parse(readFileSync(join(args.vectors, path), 'utf8'));
const KEYS = read('keys.json').keys;
const PRIVATE = Object.fromEntries(KEYS.map(k => [k.kid, { kty: k.kty, crv: k.crv, x: k.x, d: k._private_d_for_test_only }]));
const SCENARIOS = read('scenarios.json');
const SIGNER = SCENARIOS.signer;
const vectors = dir =>
  readdirSync(join(args.vectors, dir))
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ id: `${dir}/${f.replace(/\.json$/, '')}`, ...read(join(dir, f)) }));

// ── Grading ───────────────────────────────────────────────────────────────

const checks = [];
const describe = r => (r.ok ? `pass${r.identity ? ` as ${r.identity}` : ''}` : `${r.status || 'refuse'} ${r.rule ?? ''}: ${r.error ?? ''}`.trim());
const want = e => (e.success ? `pass${e.identity ? ` as ${e.identity}` : ''}` : `${e.status ?? 'refuse'}`);
// A crash fails every check: it is never a refusal, even where the check expects no status.
const meets = (expected, got) =>
  got.rule !== 'adapter-crash' &&
  (expected.success
    ? got.ok === true && (expected.identity === undefined || got.identity === expected.identity)
    : got.ok === false && (expected.status === undefined || got.status === expected.status));

function record(suite, id, expected, got, extra = {}) {
  checks.push({ suite, id, ok: meets(expected, got), expected: want(expected), got: describe(got), ...extra });
}

async function signedDirectories(map, now) {
  const out = {};
  for (const [origin, kids] of Object.entries(map)) {
    out[origin] = await judge.signDirectory({ keys: kids.map(k => PRIVATE[k]), origin, now });
  }
  return out;
}

// ── Vectors ───────────────────────────────────────────────────────────────

async function runVectors() {
  for (const v of [...vectors('positive'), ...vectors('negative')]) {
    const expected = v.expected_outcome.success
      ? { success: true, identity: Object.values(v.expected_outcome.identities)[0] }
      : { success: false, status: v.expected_outcome.status };
    if (v.response) {
      const origin = new URL(v.request.url).origin;
      const got = adapter({ op: 'verify_directory', origin, response: { url: v.request.url, ...v.response }, now: v.reference_now });
      record('vectors', v.id, { success: expected.success }, got);
      continue;
    }
    const keysRef = Object.fromEntries(Object.entries(v.directories ?? {}).map(([o, d]) => [o, d.keys_ref]));
    const directories = await signedDirectories(keysRef, v.reference_now);
    // A black-box verifier builds replay state by verifying the replayed request first.
    const prior = (v.test_harness_state?.replay_cache_entries ?? []).length > 0 ? [v.request] : [];
    record('vectors', v.id, expected, adapter({ op: 'verify_request', request: v.request, directories, now: v.reference_now, prior }));
  }
}

// ── Live ──────────────────────────────────────────────────────────────────

async function runLive(now) {
  const key = PRIVATE[SIGNER.kid];
  const origin = SIGNER.identity;
  const ok = { success: true, identity: origin };
  const theirs = adapter({ op: 'sign_directory', keys: [key], origin, now });
  record('live', 'adapter signs the directory, judge verifies', { success: true }, theirs.ok === false ? theirs : await judge.verifyDirectory({ origin, response: theirs, now }));
  const ours = await judge.signDirectory({ keys: [key], origin, now });
  record('live', 'judge signs the directory, adapter verifies', { success: true }, adapter({ op: 'verify_directory', origin, response: ours, now }));
  for (const [name, request] of Object.entries(SCENARIOS.requests)) {
    const signed = adapter({ op: 'sign_request', key, origin, request, now });
    const got = signed.ok === false || theirs.ok === false ? signed.ok === false ? signed : theirs : await judge.verifyRequest({ request: signed, directories: { [origin]: theirs }, now });
    record('live', `adapter signs ${name.toUpperCase()}, judge verifies`, ok, got);
    const mine = await judge.signRequest({ key, origin, request, now });
    record('live', `judge signs ${name.toUpperCase()}, adapter verifies`, ok, adapter({ op: 'verify_request', request: mine, directories: { [origin]: ours }, now, prior: [] }));
    if (name === 'post') {
      record('live', 'judge signs POST, adapter verifies it twice', { success: false, status: 429 }, adapter({ op: 'verify_request', request: mine, directories: { [origin]: ours }, now, prior: [mine] }));
    }
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────

// The tier check: the bare library alone decides a "wba" scenario, and only the policy decides an "adcp" one.
function recordTier(s, bare, withPolicy) {
  const bareMatches = bare.ok === s.expected.success;
  checks.push({
    suite: 'tiers',
    id: `${s.id} ${s.name}`,
    ok: meets(s.expected, withPolicy) && (s.tier === 'wba' ? bareMatches : !bareMatches),
    expected: `${s.tier}: bare ${s.tier === 'wba' ? want({ success: s.expected.success }) : want({ success: !s.expected.success })}, policy ${want(s.expected)}`,
    got: `bare ${describe(bare)}; policy ${describe(withPolicy)}`,
  });
}

async function runScenarios(now) {
  const defaultDirectories = { [SIGNER.identity]: [SIGNER.kid] };
  for (const s of SCENARIOS.request_scenarios) {
    const request = await judge.signScenario(SCENARIOS, s, PRIVATE, now);
    const directories = await signedDirectories(s.directories ?? defaultDirectories, now);
    const op = { request, directories, now, prior: [] };
    record('scenarios', `${s.id} ${s.name}`, s.expected, adapter({ op: 'verify_request', ...op }), { tier: s.tier });
    if (args.self) recordTier(s, await judge.verifyRequest(op, { bare: true }), await judge.verifyRequest(op));
  }
  for (const s of SCENARIOS.directory_scenarios) {
    const { id, name, expected, tier, basis, keys = [SIGNER.kid], ...options } = s;
    const response = await judge.signDirectory({ ...options, keys: keys.map(k => PRIVATE[k]), origin: SIGNER.identity, now });
    const op = { origin: SIGNER.identity, response, now };
    record('scenarios', `${id} ${name}`, expected, adapter({ op: 'verify_directory', ...op }), { tier });
    if (args.self) recordTier(s, await judge.verifyDirectory(op, { bare: true }), await judge.verifyDirectory(op));
  }
}

// ── Report ────────────────────────────────────────────────────────────────

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function junit(path) {
  const suites = [...new Set(checks.map(c => c.suite))].map(suite => {
    const cases = checks.filter(c => c.suite === suite);
    const body = cases
      .map(c => {
        const tc = `<testcase classname="wba-interop.${suite}" name="${xml(c.id)}"`;
        return c.ok ? `${tc}/>` : `${tc}><failure message="${xml(`expected ${c.expected}, got ${c.got}`)}"/></testcase>`;
      })
      .join('\n    ');
    return `  <testsuite name="wba-interop.${suite}" tests="${cases.length}" failures="${cases.filter(c => !c.ok).length}">\n    ${body}\n  </testsuite>`;
  });
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="wba-interop">\n${suites.join('\n')}\n</testsuites>\n`);
}

const now = Math.floor(Date.now() / 1000);
await runVectors();
await runLive(now);
await runScenarios(now);

console.log(`Web Bot Auth interop: ${args.self ? 'judge self-check' : `adapter ${command}`}\n`);
for (const c of checks) console.log(`${c.ok ? 'pass' : 'FAIL'}  ${c.suite.padEnd(9)} ${c.tier ? `[${c.tier}] ` : ''}${c.id}${c.ok ? '' : `\n        expected ${c.expected}\n        got      ${c.got}`}`);
const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks pass.`);
for (const tier of ['wba', 'adcp']) {
  const t = checks.filter(c => c.suite === 'scenarios' && c.tier === tier);
  const label = tier === 'wba' ? 'breaks WBA' : 'breaks an AdCP addition';
  console.log(`Scenarios, tier ${tier}: ${t.filter(c => c.ok).length} of ${t.length} pass (a failure ${label}).`);
}
if (args.junit) junit(args.junit);
process.exitCode = failed.length === 0 ? 0 : 1;
