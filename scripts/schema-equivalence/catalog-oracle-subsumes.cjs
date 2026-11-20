#!/usr/bin/env node
'use strict';

/**
 * Reruns the subsumes oracle on every construct catalog pair, in both
 * directions, and records its verdicts in the catalog files
 * (test/catalog/<group>/<construct>.json, one `subsumes` record per pair).
 * See test/catalog/README.md.
 *
 *   node scripts/schema-equivalence/catalog-oracle-subsumes.cjs
 *
 * subsumes (https://github.com/georg-wolflein/subsumes, MIT) has no command
 * line tool; its `harness run` checks a folder of cases in both directions.
 * Install that binary at the pinned commit:
 *
 *   cargo install --locked --git https://github.com/georg-wolflein/subsumes \
 *     --rev 9a9d00afa3e1c46015949a74faa91b4ce71f4ab0 harness
 *
 * With `--root DIR`, set SUBSUMES_ROOT=DIR.
 *
 * Each side goes through the prototype's bundling (catalog-generator/
 * oracle-bundle.cjs, which turns `discriminator` into Ajv's formula) and is
 * then translated from draft-07 to draft 2020-12, the only dialect subsumes
 * reads. A verdict is recorded as follows:
 *
 *   - `no` only with a counterexample that the repo's Ajv configuration
 *     confirms against the pair's files; otherwise `unknown`;
 *   - `unproven` for a `yes` on a pair that uses `format` `date-time`, `uuid`
 *     or `uri` (subsumes reads them by the RFC grammars, not as ajv-formats
 *     does), or a pattern that names a surrogate code point (subsumes models
 *     strings as Unicode scalar values and can't see lone surrogates);
 *   - `unknown` stays `unknown`.
 *
 * A decided direction must agree with the pair's label. On any disagreement,
 * or a decided direction that the label leaves open, the script names the
 * pair, writes nothing, and exits 1.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAjv } = require('./lib/ajv.cjs');
const { inclusionProblems } = require('./test/catalog-generator/oracle-bundle.cjs');

const SUBSUMES_REPO = 'https://github.com/georg-wolflein/subsumes';
const SUBSUMES_COMMIT = '9a9d00afa3e1c46015949a74faa91b4ce71f4ab0';
const INSTALL = `cargo install --locked --git ${SUBSUMES_REPO} --rev ${SUBSUMES_COMMIT} harness`;
const CATALOG = path.join(__dirname, 'test', 'catalog');
const DIRECTIONS = ['base_in_head', 'head_in_base'];
const UNPROVEN_FORMATS = new Set(['date-time', 'uuid', 'uri']);
const AJV_RULES = new Set(Object.keys(createAjv().RULES.all));

/** The harness binary, installed by `cargo install` at the pinned commit. */
function harness() {
  const root = process.env.SUBSUMES_ROOT || process.env.CARGO_INSTALL_ROOT || process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const bin = path.join(root, 'bin', 'harness');
  const pin = `harness 0.4.0 (git+${SUBSUMES_REPO}?rev=${SUBSUMES_COMMIT}#${SUBSUMES_COMMIT})`;
  let installs = {};
  try {
    installs = JSON.parse(fs.readFileSync(path.join(root, '.crates2.json'), 'utf8')).installs;
  } catch {
    // no cargo install record under this root
  }
  if (!installs[pin] || !fs.existsSync(bin)) {
    throw new Error(`subsumes harness at ${SUBSUMES_COMMIT} is not installed under ${root}. Install it with\n  ${INSTALL}\nand, with --root DIR, set SUBSUMES_ROOT=DIR.`);
  }
  return bin;
}

/** Draft-07, as Ajv reads it, to draft 2020-12. Keywords Ajv doesn't assert are dropped. */
function to2020(node) {
  if (typeof node === 'boolean') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref') out.$ref = v.replace(/^#\/definitions\//, '#/$defs/');
    else if (k === 'items' && Array.isArray(v)) {
      out.prefixItems = v.map(to2020);
      if (node.additionalItems !== undefined) out.items = to2020(node.additionalItems);
    } else if (k === 'additionalItems') continue; // with an items array only, as above
    else if (k === 'dependencies') {
      for (const [name, dep] of Object.entries(v)) {
        if (Array.isArray(dep)) (out.dependentRequired ||= {})[name] = dep;
        else (out.dependentSchemas ||= {})[name] = to2020(dep);
      }
    } else if (!AJV_RULES.has(k)) continue;
    else if (['not', 'if', 'then', 'else', 'contains', 'propertyNames', 'additionalProperties', 'items'].includes(k)) out[k] = to2020(v);
    else if (['allOf', 'anyOf', 'oneOf'].includes(k)) out[k] = v.map(to2020);
    else if (['properties', 'patternProperties'].includes(k)) out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, to2020(s)]));
    else out[k] = v;
  }
  return out;
}

/** The base and head roots of a pair as two draft 2020-12 documents. */
function sides(pair) {
  const { fwd } = inclusionProblems(pair.base, pair.head, pair.root);
  const $defs = Object.fromEntries(Object.entries(fwd.definitions).map(([id, s]) => [id, to2020(s)]));
  const doc = ref => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs, $ref: ref.replace('#/definitions/', '#/$defs/') });
  return { base: doc(fwd.allOf[0].$ref), head: doc(fwd.allOf[1].not.$ref) };
}

/** Whether an ECMAScript `u`-mode pattern names a surrogate code point, alone or in a class range. */
function namesSurrogate(s) {
  const SURROGATE = cp => cp >= 0xd800 && cp <= 0xdfff;
  const tokens = [];
  for (let i = 0; i < s.length;) {
    if (s[i] !== '\\') {
      const cp = s.codePointAt(i);
      tokens.push('[]-'.includes(s[i]) ? { op: s[i] } : { cp });
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    const c = s[i + 1];
    const hex = (from, to) => parseInt(s.slice(from, to), 16);
    if (c === 'p' || c === 'P') return true; // a property escape may single out surrogates
    if (c === 'u' && s[i + 2] === '{') {
      const end = s.indexOf('}', i);
      tokens.push({ cp: hex(i + 3, end) });
      i = end + 1;
    } else if (c === 'u') {
      let cp = hex(i + 2, i + 6);
      i += 6;
      const trail = s[i] === '\\' && s[i + 1] === 'u' ? hex(i + 2, i + 6) : NaN;
      if (cp >= 0xd800 && cp <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (trail - 0xdc00);
        i += 6;
      }
      tokens.push({ cp });
    } else if (c === 'x') {
      tokens.push({ cp: hex(i + 2, i + 4) });
      i += 4;
    } else {
      tokens.push(/[A-Za-z0-9]/.test(c) ? { cls: c } : { cp: c.codePointAt(0) });
      i += 2;
    }
  }
  let inClass = false;
  return tokens.some((t, i) => {
    if (t.op === '[') inClass = true;
    if (t.op === ']') inClass = false;
    if (SURROGATE(t.cp)) return true;
    const [lo, hi] = [tokens[i - 1], tokens[i + 1]];
    return inClass && t.op === '-' && lo && hi && lo.cp !== undefined && hi.cp !== undefined && lo.cp <= 0xdfff && hi.cp >= 0xd800;
  });
}

/** Why a `yes` on this pair is not evidence under Ajv, or null. */
function unprovenReason(pair) {
  const reasons = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'format' && UNPROVEN_FORMATS.has(x)) reasons.add(`format ${x} differs from ajv-formats`);
      if (k === 'pattern' && typeof x === 'string' && namesSurrogate(x)) reasons.add('a pattern names a surrogate code point');
      if (k === 'patternProperties' && Object.keys(x).some(namesSurrogate)) reasons.add('a pattern names a surrogate code point');
      walk(x);
    }
  };
  walk([pair.base, pair.head]);
  return reasons.size ? [...reasons].join('; ') : null;
}

function validator(files, root) {
  const ajv = createAjv();
  for (const doc of Object.values(files)) ajv.addSchema(doc);
  return ajv.getSchema(`/schemas/${root}`);
}

/** The recorded verdict of one direction from a harness result line. */
function record(pair, dir, result, why) {
  if (result.verdict === 'yes') return why ? { verdict: 'unproven', reason: why } : { verdict: 'yes' };
  if (result.verdict === 'unknown') return { verdict: 'unknown', reason: result.detail };
  if (result.verdict !== 'no') throw new Error(`${pair.id} ${dir}: subsumes ${result.verdict}: ${result.message}`);
  // base_in_head is false when some payload is valid on the base and invalid on the head.
  const [inside, outside] = dir === 'base_in_head' ? ['base', 'head'] : ['head', 'base'];
  const x = result.counterexample;
  if (validator(pair[inside], pair.root)(x) && !validator(pair[outside], pair.root)(x)) return { verdict: 'no', counterexample: x };
  return { verdict: 'unknown', reason: 'counterexample not confirmed by Ajv', counterexample: x };
}

function main() {
  const bin = harness();
  const files = fs.readdirSync(CATALOG, { withFileTypes: true }).filter(d => d.isDirectory())
    .flatMap(d => fs.readdirSync(path.join(CATALOG, d.name)).filter(f => f.endsWith('.json')).map(f => path.join(CATALOG, d.name, f)))
    .sort()
    .map(f => ({ f, doc: JSON.parse(fs.readFileSync(f, 'utf8')) }));
  const pairs = files.flatMap(({ doc }) => doc.pairs);

  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-subsumes-'));
  const t0 = Date.now();
  let lines;
  try {
    fs.mkdirSync(path.join(corpus, 'catalog'));
    fs.writeFileSync(path.join(corpus, 'catalog', 'collection.json'), '{}');
    pairs.forEach((p, i) => {
      const { base, head } = sides(p);
      // a_subsumes_b is subsumes(head, base): base_in_head.
      fs.writeFileSync(path.join(corpus, 'catalog', `${i}.json`), JSON.stringify({ a_subsumes_b: null, b_subsumes_a: null, a: head, b: base }));
    });
    const out = path.join(corpus, 'results.jsonl');
    const run = spawnSync(bin, ['run', corpus, out, '--jobs', String(os.availableParallelism())], { encoding: 'utf8' });
    // Exit 1 flags its own validator's doubts; Ajv decides here.
    if (run.status !== 0 && run.status !== 1) throw new Error(`harness run failed (${run.status}): ${run.stderr}`);
    lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
  const results = new Map(lines.map(r => [`${r.case.replace('catalog/', '')}|${r.direction}`, r]));

  const count = { decided: 0, agree: 0, settled: 0, no: 0, confirmed: 0, yes: 0, unproven: 0, unknown: 0, checkMs: 0 };
  const conflicts = [];
  pairs.forEach((p, i) => {
    const why = unprovenReason(p);
    p.subsumes = {};
    for (const [dir, side] of [['base_in_head', 'a_subsumes_b'], ['head_in_base', 'b_subsumes_a']]) {
      const r = results.get(`${i}|${side}`);
      if (!r) throw new Error(`${p.id} ${dir}: no harness result`);
      count.checkMs += r.nanos / 1e6;
      if (r.verdict === 'no') count.no++;
      const rec = record(p, dir, r, why);
      p.subsumes[dir] = rec;
      count[rec.verdict === 'no' ? 'confirmed' : rec.verdict]++;
      if (rec.verdict !== 'yes' && rec.verdict !== 'no') continue;
      count.decided++;
      const label = p.verdict[dir];
      const says = rec.verdict === 'yes';
      if (label === null) conflicts.push(`${p.id} ${dir}: the label is open, subsumes says ${rec.verdict}`);
      else if (label !== says) conflicts.push(`${p.id} ${dir}: the ${p.decided_by === 'oracle' ? 'prototype' : 'hand verdict'} says ${label}, subsumes says ${rec.verdict}`);
      else if (p.decided_by === 'oracle') count.agree++;
      else count.settled++;
    }
  });
  const wall = (Date.now() - t0) / 1000;
  const directions = pairs.length * DIRECTIONS.length;
  process.stdout.write(`${pairs.length} pairs, ${directions} directions in ${wall.toFixed(1)} s (checks ${count.checkMs.toFixed(0)} ms)\n`
    + `decided ${count.decided}: ${count.agree} agree with the prototype, ${count.settled} settle a hand verdict, ${conflicts.length} disagree\n`
    + `no ${count.no} (${count.confirmed} confirmed by Ajv), yes ${count.yes}, unproven ${count.unproven}, unknown ${count.unknown}\n`);
  if (conflicts.length) {
    for (const c of conflicts) process.stderr.write(`DISAGREE ${c}\n`);
    process.stderr.write('Nothing written. Give each pair a hand verdict in catalog-generator/pairs.cjs that notes the disagreement.\n');
    process.exit(1);
  }
  for (const { f, doc } of files) {
    const { pairs: list, ...head } = doc;
    fs.writeFileSync(f, `${JSON.stringify({ ...head, subsumes_commit: SUBSUMES_COMMIT, pairs: list }, null, 2)}\n`);
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
}
