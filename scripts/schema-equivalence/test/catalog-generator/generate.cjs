#!/usr/bin/env node
'use strict';

/**
 * Generates the construct catalog (scripts/schema-equivalence/test/catalog/)
 * from the pair definitions in pairs.cjs. The equivalence tool under test
 * plays no part here.
 *
 * For every pair it decides inclusion in both directions:
 *   - by default with an external inclusion oracle, one process for all
 *     pairs: `<oracle> <problem.json>...` must print one JSON line per file,
 *     {"file", "verdict": "sat" | "unsat" | ..., "witness"}, for problems of
 *     the form {"definitions", "allOf": [S1, {"not": S2}]} (sat: S1 is not
 *     included in S2, and the witness is in S1 and not in S2);
 *   - by hand (`manual` in pairs.cjs) for constructs the oracle does not model
 *     like Ajv. A hand verdict lists its reason and witnesses.
 * Every witness is then checked with the repo's Ajv configuration against the
 * pair's files: it must be valid on one side and invalid on the other, in the
 * direction the verdict states. A pair whose verdict and Ajv disagree, or
 * whose oracle run fails, stops the generator.
 *
 *   node generate.cjs --oracle /path/to/run.sh --work /tmp/catalog-work [--out DIR]
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { spawnSync } = require('node:child_process');
const { createAjv } = require('../../lib/ajv.cjs');
const { inclusionProblems } = require('./oracle-bundle.cjs');
const P = require('./pairs.cjs');

const ORACLE_COMMIT = '8064ad83a0dbdb4b02c0ce1632d273f7cbf736cf';

function withIds(files) {
  const out = {};
  for (const [rel, doc] of Object.entries(files)) out[rel] = { $id: `/schemas/${rel}`, ...doc };
  return out;
}

function intentFlags(intent, flips) {
  const map = {
    eq: [true, true],
    tighten: [false, true],
    loosen: [true, false],
    diff: [null, null],
  };
  const [bh, hb] = map[intent];
  return flips ? { base_in_head: hb, head_in_base: bh } : { base_in_head: bh, head_in_base: hb };
}

/** Every pair, with files, before verdicts. */
function enumerate() {
  const pairs = [];
  const add = (p) => pairs.push(p);
  const fromSnippet = (group, construct, rule, [name, base, head, intent, opts = {}], contexts) => {
    for (const ctx of contexts) {
      const c = P.CONTEXTS[ctx];
      const manual = opts.manual && {
        reason: opts.manual.reason,
        claims: c.flips
          ? { base_in_head: opts.manual.head_in_base, head_in_base: opts.manual.base_in_head }
          : { base_in_head: opts.manual.base_in_head, head_in_base: opts.manual.head_in_base },
        witnesses: opts.manual.witnesses.map(c.lift),
      };
      add({
        id: `${group}/${construct}/${name}/${ctx}`,
        group, construct, rule, name, context: ctx,
        intent: intentFlags(intent, c.flips),
        base: withIds(c.wrap(base)),
        head: withIds(c.wrap(head)),
        root: 'a.json',
        manual,
      });
    }
  };
  for (const g of P.SNIPPETS) {
    for (const item of g.items) {
      const contexts = item[4] && item[4].contexts ? item[4].contexts : item[3] === 'eq' ? P.ALL_CONTEXTS : P.MISS_CONTEXTS;
      fromSnippet(g.group, g.construct, g.rule, item, contexts);
    }
  }
  for (const [keyword, items] of P.KEYWORDS) {
    for (const item of items) fromSnippet('keywords', keyword, `minimal ${keyword} change`, item, P.KEYWORD_CONTEXTS);
  }
  for (const g of P.OPAQUE) {
    for (const item of g.items) {
      const rule = item[3] === 'eq'
        ? `${g.construct} is compared exactly; this equivalent rewrite may be reported (false alarm)`
        : `${g.construct} is compared exactly; a real change must be reported`;
      fromSnippet('opaque', g.construct, rule, item, ['top']);
    }
  }
  for (const [construct, items] of P.NESTINGS) {
    for (const item of items) fromSnippet('nestings', construct, `changes inside ${construct}`, item, ['top']);
  }
  for (const [name, base, head, intent, note] of P.REFERENCES) {
    add({
      id: `references/${name}`,
      group: 'references', construct: 'references', rule: note, name, context: 'files',
      intent: intentFlags(intent, false),
      base: withIds(base),
      head: withIds(head),
      root: 'a.json',
    });
  }
  return pairs;
}

/** A compiled validator for a pair side's root, with every file registered by $id. */
function validator(files, root) {
  const ajv = createAjv();
  for (const doc of Object.values(files)) ajv.addSchema(doc);
  const v = ajv.getSchema(`/schemas/${root}`);
  if (!v) throw new Error(`root ${root} did not compile`);
  return v;
}

/** Constructs the oracle does not model like Ajv; such pairs need a hand verdict. */
function needsManual(files) {
  const reasons = new Set();
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.forEach(x => walk(x, key));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'format') reasons.add('format');
        if (k === 'uniqueItems' && x === true) reasons.add('uniqueItems');
        if (k === 'pattern' || k === 'patternProperties') {
          for (const p of k === 'pattern' ? [x] : Object.keys(x)) {
            if (/(^|[^\\])\./.test(p)) reasons.add('"." in a pattern');
            if (/\(\?[=!<]/.test(p)) reasons.add('lookaround');
            if (/\\u\{|\\uD[89AB]/i.test(p) || /[\u{10000}-\u{10FFFF}]/u.test(p)) reasons.add('astral characters');
          }
        }
        if (typeof x === 'string' && /[\u{10000}-\u{10FFFF}]/u.test(x)) reasons.add('astral characters');
        walk(x, k);
      }
    }
  };
  walk(files);
  return [...reasons];
}

function runOracle(oracle, work, problems) {
  fs.mkdirSync(work, { recursive: true });
  const files = problems.map(({ key, doc }) => {
    const f = path.join(work, `${key}.json`);
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  });
  const results = new Map();
  for (let i = 0; i < files.length; i += 400) {
    const chunk = files.slice(i, i + 400);
    // One oracle process at a time, with a bounded heap.
    const res = spawnSync(oracle, chunk, { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, JAVA_EXTRA: process.env.JAVA_EXTRA || '-Xmx4g -Doracle.timeout.ms=60000' } });
    for (const line of res.stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      const r = JSON.parse(line);
      results.set(path.basename(r.file, '.json'), r);
    }
  }
  return results;
}

function main() {
  const { values } = parseArgs({ options: { oracle: { type: 'string' }, work: { type: 'string' }, out: { type: 'string' } } });
  if (!values.oracle || !values.work) throw new Error('usage: generate.cjs --oracle CMD --work DIR [--out DIR]');
  const out = path.resolve(values.out || path.join(__dirname, '..', 'catalog'));
  const pairs = enumerate();
  const ids = new Set();
  for (const p of pairs) {
    if (ids.has(p.id)) throw new Error(`duplicate id ${p.id}`);
    ids.add(p.id);
    p.validators = { base: validator(p.base, p.root), head: validator(p.head, p.root) };
    const unmodelled = needsManual([p.base, p.head]);
    if (unmodelled.length && !p.manual) throw new Error(`${p.id}: uses ${unmodelled.join(', ')}; needs a hand verdict`);
    p.unmodelled = unmodelled;
  }

  // Oracle problems for every pair the oracle can decide.
  const problems = [];
  pairs.forEach((p, i) => {
    if (p.manual) return;
    const { fwd, rev } = inclusionProblems(p.base, p.head, p.root);
    problems.push({ key: `${i}.fwd`, doc: fwd }, { key: `${i}.rev`, doc: rev });
  });
  const t0 = Date.now();
  const results = runOracle(values.oracle, values.work, problems);
  const oracleMs = Date.now() - t0;

  const failures = [];
  const intentMismatches = [];
  pairs.forEach((p, i) => {
    let verdict;
    const witnesses = [];
    const check = (payload) => {
      const b = p.validators.base(payload);
      const h = p.validators.head(payload);
      return { payload, base: b, head: h };
    };
    if (p.manual) {
      for (const w of p.manual.witnesses) witnesses.push(check(w));
      const { base_in_head, head_in_base } = p.manual.claims;
      // A claim of inclusion must survive every witness; a claim of non-inclusion needs one.
      const bNotH = witnesses.some(w => w.base && !w.head);
      const hNotB = witnesses.some(w => w.head && !w.base);
      if (base_in_head === true && bNotH) failures.push(`${p.id}: hand verdict says base in head, an Ajv witness says not`);
      if (head_in_base === true && hNotB) failures.push(`${p.id}: hand verdict says head in base, an Ajv witness says not`);
      if (base_in_head === false && !bNotH) failures.push(`${p.id}: hand verdict says base not in head, no witness shows it`);
      if (head_in_base === false && !hNotB) failures.push(`${p.id}: hand verdict says head not in base, no witness shows it`);
      verdict = { base_in_head, head_in_base };
    } else {
      const f = results.get(`${i}.fwd`);
      const r = results.get(`${i}.rev`);
      for (const [dir, res] of [['fwd', f], ['rev', r]]) {
        if (!res || !['sat', 'unsat'].includes(res.verdict)) {
          failures.push(`${p.id}: oracle ${dir} ${res ? `${res.verdict} ${res.error || ''}` : 'no result'}`);
          continue;
        }
        if (res.verdict === 'sat') {
          const w = check(res.witness);
          const ok = dir === 'fwd' ? w.base && !w.head : w.head && !w.base;
          if (!ok) failures.push(`${p.id}: oracle ${dir} witness ${JSON.stringify(res.witness)} not confirmed by Ajv (base ${w.base}, head ${w.head})`);
          witnesses.push(w);
        }
      }
      verdict = { base_in_head: f && f.verdict === 'unsat', head_in_base: r && r.verdict === 'unsat' };
    }
    verdict.equivalent = verdict.base_in_head === true && verdict.head_in_base === true;
    if (!verdict.equivalent && witnesses.every(w => w.base === w.head)) failures.push(`${p.id}: not equivalent but no distinguishing witness`);
    for (const k of ['base_in_head', 'head_in_base']) {
      if (p.intent[k] !== null && p.intent[k] !== verdict[k]) intentMismatches.push(`${p.id}: intent ${k}=${p.intent[k]}, decided ${verdict[k]}`);
    }
    p.verdict = verdict;
    p.witnesses = witnesses.filter(w => w.base !== w.head);
  });

  for (const m of intentMismatches) process.stderr.write(`intent mismatch: ${m}\n`);
  if (failures.length) {
    for (const f of failures) process.stderr.write(`FAIL ${f}\n`);
    process.exit(1);
  }

  // Write one file per group and construct.
  // Replace the group directories only; README.md and false-alarms.json stay.
  for (const g of new Set(pairs.map(p => p.group))) fs.rmSync(path.join(out, g), { recursive: true, force: true });
  const byFile = new Map();
  for (const p of pairs) {
    const key = `${p.group}/${p.construct}.json`;
    if (!byFile.has(key)) byFile.set(key, []);
    const rec = {
      id: p.id,
      rule: p.rule,
      context: p.context,
      root: p.root,
      base: p.base,
      head: p.head,
      verdict: { equivalent: p.verdict.equivalent, base_in_head: p.verdict.base_in_head, head_in_base: p.verdict.head_in_base },
      decided_by: p.manual ? 'manual' : 'oracle',
    };
    if (p.manual) rec.manual_reason = p.manual.reason;
    if (p.witnesses.length) rec.witnesses = p.witnesses;
    byFile.get(key).push(rec);
  }
  for (const [key, list] of byFile) {
    const f = path.join(out, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ oracle_commit: ORACLE_COMMIT, pairs: list }, null, 2)}\n`);
  }
  const eq = pairs.filter(p => p.verdict.equivalent).length;
  process.stdout.write(`${pairs.length} pairs (${eq} equivalent, ${pairs.length - eq} different), ${pairs.filter(p => p.manual).length} decided by hand, ${problems.length} oracle problems in ${oracleMs} ms, ${byFile.size} files, ${intentMismatches.length} intent mismatches\n`);
}

main();
