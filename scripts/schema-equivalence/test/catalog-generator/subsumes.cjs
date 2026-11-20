'use strict';

/**
 * The catalog's inclusion oracle: subsumes
 * (https://github.com/georg-wolflein/subsumes, MIT) at a pinned commit, run
 * through its `harness run` binary, since subsumes has no command line tool.
 * Install it with
 *
 *   cargo install --locked --git https://github.com/georg-wolflein/subsumes \
 *     --rev 9a9d00afa3e1c46015949a74faa91b4ce71f4ab0 harness
 *
 * and, with `--root DIR`, set SUBSUMES_ROOT=DIR.
 *
 * Each side goes through the bundling in oracle-bundle.cjs (which turns
 * `discriminator` into Ajv's formula) and is then translated from draft-07 to
 * draft 2020-12, the only dialect subsumes reads. A verdict is recorded as
 * follows:
 *
 *   - `no` only with a counterexample that the repo's Ajv configuration
 *     confirms against the pair's files; otherwise `unknown`;
 *   - `unproven` for a `yes` on a pair that uses `format` `date-time`, `uuid`
 *     or `uri` (subsumes reads them by the RFC grammars, not as ajv-formats
 *     does), or a pattern that names a surrogate code point (subsumes models
 *     strings as Unicode scalar values and can't see lone surrogates), or
 *     that uses `multipleOf`, `type: integer` beside a numeric bound, or a
 *     number above 2^53 in magnitude (subsumes reasons over exact numbers;
 *     Ajv uses doubles, and parseInt for `multipleOf`);
 *   - `unknown` stays `unknown`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAjv } = require('../../lib/ajv.cjs');
const { inclusionProblems } = require('./oracle-bundle.cjs');

const SUBSUMES_REPO = 'https://github.com/georg-wolflein/subsumes';
const SUBSUMES_COMMIT = '9a9d00afa3e1c46015949a74faa91b4ce71f4ab0';
const INSTALL = `cargo install --locked --git ${SUBSUMES_REPO} --rev ${SUBSUMES_COMMIT} harness`;
const UNPROVEN_FORMATS = new Set(['date-time', 'uuid', 'uri']);
const NUMERIC_BOUNDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']);
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
  let integer = false;
  let bound = false;
  const walk = (v) => {
    if (typeof v === 'number' && Math.abs(v) > 2 ** 53) reasons.add('a number above 2^53 in magnitude, where Ajv\'s doubles lose integers');
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'multipleOf') reasons.add('multipleOf, which Ajv checks on doubles with parseInt');
      if (k === 'type' && [].concat(x).includes('integer')) integer = true;
      if (NUMERIC_BOUNDS.has(k)) bound = true;
      if (k === 'format' && UNPROVEN_FORMATS.has(x)) reasons.add(`format ${x} differs from ajv-formats`);
      if (k === 'pattern' && typeof x === 'string' && namesSurrogate(x)) reasons.add('a pattern names a surrogate code point');
      if (k === 'patternProperties' && Object.keys(x).some(namesSurrogate)) reasons.add('a pattern names a surrogate code point');
      walk(x);
    }
  };
  walk([pair.base, pair.head]);
  if (integer && bound) reasons.add('type integer beside numeric bounds, which Ajv compares as doubles');
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

/**
 * Checks every pair in both directions. Returns, per pair, the recorded
 * verdict of `base_in_head` and `head_in_base`, and the time the checks took.
 */
function runSubsumes(pairs) {
  const bin = harness();
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-subsumes-'));
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
    // Exit 1 flags the harness's own validator's doubts; Ajv decides here.
    if (run.status !== 0 && run.status !== 1) throw new Error(`harness run failed (${run.status}): ${run.stderr}`);
    lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
  const results = new Map(lines.map(r => [`${r.case.replace('catalog/', '')}|${r.direction}`, r]));
  let checkMs = 0;
  const records = pairs.map((p, i) => {
    const why = unprovenReason(p);
    const rec = {};
    for (const [dir, side] of [['base_in_head', 'a_subsumes_b'], ['head_in_base', 'b_subsumes_a']]) {
      const r = results.get(`${i}|${side}`);
      if (!r) throw new Error(`${p.id} ${dir}: no harness result`);
      checkMs += r.nanos / 1e6;
      rec[dir] = record(p, dir, r, why);
    }
    return rec;
  });
  return { records, checkMs };
}

module.exports = { runSubsumes, SUBSUMES_COMMIT };
