#!/usr/bin/env node
'use strict';

/**
 * Generates the construct catalog (scripts/schema-equivalence/test/catalog/)
 * from the pair definitions in pairs.cjs. The equivalence tool under test
 * plays no part here.
 *
 * Every pair is checked in both directions with subsumes (subsumes.cjs). Its
 * label comes from one of three sources:
 *   - a hand verdict (`manual` in pairs.cjs), with its reason and witnesses;
 *   - the frozen prototype verdict already in the catalog, for a pair whose
 *     files are unchanged (`decided_by: oracle`); the prototype is not run;
 *   - otherwise subsumes, which must settle both directions with `yes` or an
 *     Ajv-confirmed `no` (`decided_by: subsumes`). A pair it can't settle
 *     needs a hand verdict.
 * A subsumes `yes` or `no` must agree with a hand or prototype label.
 * Every witness is checked with the repo's Ajv configuration against the
 * pair's files: it must be valid on one side and invalid on the other, in the
 * direction the verdict states. Any failure stops the generator before it
 * writes anything.
 *
 *   node generate.cjs [--out DIR]
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createAjv } = require('../../lib/ajv.cjs');
const { runSubsumes, SUBSUMES_COMMIT } = require('./subsumes.cjs');
const P = require('./pairs.cjs');

// The prototype (arXiv 2603.25306) whose verdicts the catalog keeps as a frozen record.
const ORACLE_COMMIT = '8064ad83a0dbdb4b02c0ce1632d273f7cbf736cf';
const ORACLE_FROZEN = '2026-11-20';

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

/** The frozen prototype verdicts in a catalog directory, by pair id. */
function frozenVerdicts(out) {
  const frozen = new Map();
  if (!fs.existsSync(out)) return frozen;
  for (const d of fs.readdirSync(out, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(out, d.name)).filter(n => n.endsWith('.json'))) {
      for (const rec of JSON.parse(fs.readFileSync(path.join(out, d.name, f), 'utf8')).pairs) {
        if (rec.decided_by === 'oracle') frozen.set(rec.id, rec);
      }
    }
  }
  return frozen;
}

function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const out = path.resolve(values.out || path.join(__dirname, '..', 'catalog'));
  const pairs = enumerate();
  const frozen = frozenVerdicts(out);
  const ids = new Set();
  for (const p of pairs) {
    if (ids.has(p.id)) throw new Error(`duplicate id ${p.id}`);
    ids.add(p.id);
    p.validators = { base: validator(p.base, p.root), head: validator(p.head, p.root) };
    const f = frozen.get(p.id);
    const same = f && JSON.stringify([f.base, f.head]) === JSON.stringify([p.base, p.head]);
    if (!p.manual && same) p.frozen = f;
  }

  const t0 = Date.now();
  const { records, checkMs } = runSubsumes(pairs);
  const subsumesMs = Date.now() - t0;

  const failures = [];
  const intentMismatches = [];
  pairs.forEach((p, i) => {
    const sub = records[i];
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
    } else if (p.frozen) {
      for (const w of p.frozen.witnesses || []) {
        const c = check(w.payload);
        if (c.base !== w.base || c.head !== w.head) failures.push(`${p.id}: frozen witness ${JSON.stringify(w.payload)} no longer holds under Ajv`);
        witnesses.push(c);
      }
      verdict = { base_in_head: p.frozen.verdict.base_in_head, head_in_base: p.frozen.verdict.head_in_base };
    } else {
      verdict = {};
      for (const [dir, rec] of Object.entries(sub)) {
        if (rec.verdict === 'no') witnesses.push(check(rec.counterexample));
        else if (rec.verdict !== 'yes') failures.push(`${p.id}: subsumes can't settle ${dir} (${rec.verdict}: ${rec.reason}); give the pair a hand verdict in pairs.cjs`);
        verdict[dir] = rec.verdict === 'yes';
      }
    }
    if (p.manual || p.frozen) {
      const source = p.manual ? 'hand verdict' : 'frozen prototype verdict';
      for (const [dir, rec] of Object.entries(sub)) {
        if (rec.verdict !== 'yes' && rec.verdict !== 'no') continue;
        if (verdict[dir] === null) failures.push(`${p.id}: the hand verdict leaves ${dir} open, subsumes says ${rec.verdict}`);
        else if (verdict[dir] !== (rec.verdict === 'yes')) failures.push(`${p.id}: the ${source} says ${dir} ${verdict[dir]}, subsumes says ${rec.verdict}; give the pair a hand verdict that notes the disagreement`);
      }
    }
    verdict.equivalent = verdict.base_in_head === true && verdict.head_in_base === true;
    const unsettled = !p.manual && !p.frozen && Object.values(sub).some(r => r.verdict !== 'yes' && r.verdict !== 'no');
    if (!unsettled && !verdict.equivalent && witnesses.every(w => w.base === w.head)) failures.push(`${p.id}: not equivalent but no distinguishing witness`);
    for (const k of ['base_in_head', 'head_in_base']) {
      if (p.intent[k] !== null && p.intent[k] !== verdict[k]) intentMismatches.push(`${p.id}: intent ${k}=${p.intent[k]}, decided ${verdict[k]}`);
    }
    p.verdict = verdict;
    p.witnesses = witnesses.filter(w => w.base !== w.head);
    p.subsumes = sub;
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
      decided_by: p.manual ? 'manual' : p.frozen ? 'oracle' : 'subsumes',
    };
    if (p.manual) rec.manual_reason = p.manual.reason;
    if (p.witnesses.length) rec.witnesses = p.witnesses;
    rec.subsumes = p.subsumes;
    byFile.get(key).push(rec);
  }
  for (const [key, list] of byFile) {
    const f = path.join(out, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ oracle_commit: ORACLE_COMMIT, oracle_frozen: ORACLE_FROZEN, subsumes_commit: SUBSUMES_COMMIT, pairs: list }, null, 2)}\n`);
  }
  const count = (k) => pairs.filter(k).length;
  const eq = count(p => p.verdict.equivalent);
  process.stdout.write(`${pairs.length} pairs (${eq} equivalent, ${pairs.length - eq} different): ${count(p => p.frozen)} frozen prototype, ${count(p => p.manual)} by hand, ${count(p => !p.manual && !p.frozen)} by subsumes; `
    + `subsumes checks in ${subsumesMs} ms (${checkMs.toFixed(0)} ms in checks), ${byFile.size} files, ${intentMismatches.length} intent mismatches\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
}
