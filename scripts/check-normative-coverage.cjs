#!/usr/bin/env node
/**
 * Normative-statement registry linter + coverage dashboard.
 *
 * The registry (static/registry/normative-statements/index.json) catalogs every
 * security-relevant MUST/SHOULD and every security claim in the spec, tagged with
 * where it is enforced. This script is the enforcement point that keeps the
 * registry honest — schema validation alone can't tell "claims to be enforced"
 * from "actually has a passing check behind it".
 *
 * Fails CI (exit 1) when:
 *   - an entry is malformed (missing required fields, bad id/source shape)
 *   - an entry has status=enforced but an empty enforced_by/demonstrated_by
 *   - an enforced_by/demonstrated_by path does not exist on disk
 *   - the enforced-fraction regresses below the ratchet floor (see --ratchet)
 *
 * Does NOT fail on status=gap with no enforcement — that is the honest starting
 * state the registry exists to make visible.
 *
 * See specs/spec-anti-drift.md.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = path.join(ROOT, 'static/registry/normative-statements/index.json');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const ratchetIdx = args.indexOf('--ratchet');
const ratchet = ratchetIdx !== -1 ? Number.parseFloat(args[ratchetIdx + 1]) : null;
// --min-enforced is the one-way ratchet: it counts ENFORCED statements, not a
// fraction, so honestly cataloguing a new `gap` (which grows the denominator)
// never fails the gate — only losing an enforced statement does.
const minIdx = args.indexOf('--min-enforced');
const minEnforced = minIdx !== -1 ? Number.parseInt(args[minIdx + 1], 10) : null;

const ID_RE = /^NS-[A-Z]+-[0-9]{3}$/;
const SOURCE_RE = /^(docs|static)\/.+:[0-9]+$/;
const LINK_RE = /^(docs|static|scripts|tests|server|specs)\/.+/;
const LEVELS = new Set(['MUST', 'MUST NOT', 'SHOULD', 'SHOULD NOT', 'MAY']);
const LAYERS = new Set([
  'schema', 'lint', 'conformance-vector', 'executable-snippet',
  'operator-responsibility', 'unenforceable-by-design', 'UNASSIGNED',
]);
const STATUSES = new Set(['enforced', 'gap', 'operator', 'by-design']);
const CLASSES = new Set([
  'signing', 'governance', 'identity', 'isolation', 'idempotency',
  'privacy', 'creative', 'signals', 'transport',
]);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function linkExists(rel) {
  // A link may point at file:line or a plain path; strip a trailing :NN if present.
  const filePart = rel.replace(/:[0-9]+$/, '');
  const resolved = path.resolve(ROOT, filePart);
  // Defense in depth: refuse to probe outside the repo even if a link slips a
  // `..` past LINK_RE (the prefix anchor already blocks leading `..`).
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return false;
  return fs.existsSync(resolved);
}

if (!fs.existsSync(REGISTRY)) {
  fail(`registry not found at ${path.relative(ROOT, REGISTRY)}`);
  process.exit(1);
}

let entries;
try {
  entries = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
} catch (e) {
  fail(`registry is not valid JSON: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  fail('registry must be a JSON array of entries');
  process.exit(1);
}

const seenIds = new Set();
let hardErrors = 0;

for (const [i, e] of entries.entries()) {
  const where = e && e.id ? e.id : `entry[${i}]`;
  const bad = (m) => { fail(`${where}: ${m}`); hardErrors++; };

  if (!e || typeof e !== 'object') { bad('not an object'); continue; }
  if (!ID_RE.test(e.id || '')) bad(`id must match ${ID_RE}`);
  if (seenIds.has(e.id)) bad('duplicate id'); else seenIds.add(e.id);
  if (e.type !== 'normative-statement' && e.type !== 'claim') bad('type must be normative-statement|claim');
  if (!CLASSES.has(e.class)) bad(`class invalid (got ${JSON.stringify(e.class)})`);
  if (typeof e.statement !== 'string' || e.statement.length < 10) bad('statement too short/missing');
  if (!SOURCE_RE.test(e.source || '')) bad(`source must be file:line (got ${JSON.stringify(e.source)})`);
  if (!LEVELS.has(e.level)) bad('level invalid');
  if (!LAYERS.has(e.enforcement_layer)) bad('enforcement_layer invalid');
  if (!STATUSES.has(e.status)) bad('status invalid');

  const links = e.type === 'claim' ? e.demonstrated_by : e.enforced_by;
  const linkField = e.type === 'claim' ? 'demonstrated_by' : 'enforced_by';

  if (e.status === 'enforced') {
    if (!Array.isArray(links) || links.length === 0) {
      bad(`status=enforced requires a non-empty ${linkField}`);
    } else {
      for (const l of links) {
        if (!LINK_RE.test(l)) bad(`${linkField} path has bad shape: ${l}`);
        else if (!linkExists(l)) bad(`${linkField} points at a missing file: ${l}`);
      }
    }
  }
}

// Coverage dashboard
const byStatus = {};
const byClass = {};
for (const e of entries) {
  byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  byClass[e.class] = byClass[e.class] || { total: 0, enforced: 0 };
  byClass[e.class].total++;
  if (e.status === 'enforced') byClass[e.class].enforced++;
}
const total = entries.length;
const enforced = byStatus.enforced || 0;
const gaps = byStatus.gap || 0;
const enforcedFraction = total ? enforced / total : 1;

if (asJson) {
  console.log(JSON.stringify({ total, byStatus, byClass, enforcedFraction, hardErrors }, null, 2));
} else {
  console.log('\nNormative-statement coverage');
  console.log('============================');
  console.log(`total statements : ${total}`);
  console.log(`enforced         : ${enforced} (${(enforcedFraction * 100).toFixed(1)}%)`);
  console.log(`gaps (drift)     : ${gaps}`);
  console.log(`operator/by-design: ${(byStatus.operator || 0) + (byStatus['by-design'] || 0)}`);
  console.log('\nby class (enforced/total):');
  for (const [cls, c] of Object.entries(byClass).sort()) {
    console.log(`  ${cls.padEnd(12)} ${c.enforced}/${c.total}`);
  }
  if (gaps > 0) {
    console.log('\nopen gaps:');
    for (const e of entries.filter((x) => x.status === 'gap')) {
      console.log(`  ${e.id}  ${e.source}  ${e.finding_ref || ''}`);
    }
  }
}

if (ratchet !== null && enforcedFraction < ratchet) {
  fail(`enforced fraction ${(enforcedFraction * 100).toFixed(1)}% is below ratchet floor ${(ratchet * 100).toFixed(1)}%`);
}
if (minEnforced !== null && enforced < minEnforced) {
  fail(`enforced count ${enforced} is below the one-way floor of ${minEnforced} — an enforced statement was lost`);
}

if (process.exitCode === 1) {
  console.error(`\n✗ normative-coverage check failed (${hardErrors} entry error(s))`);
} else if (!asJson) {
  console.log('\n✓ registry is well-formed; enforced entries all have live links');
}
