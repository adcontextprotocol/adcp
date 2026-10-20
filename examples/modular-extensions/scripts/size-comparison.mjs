#!/usr/bin/env node
// Like-for-like size numbers: PR #8102 (the core route to "the seller may slip a video")
// against the extension packages in packages/ (the same need as an extension).
//
//   node scripts/size-comparison.mjs        -> analysis/size-comparison.json
//
// Counting rule, the same on both sides: a line is a newline-terminated line of a file
// (`wc -l`); for #8102 that is git's insertions and deletions against the merge base. The PR
// side needs a protocol checkout with the PR head fetched:
//   git -C $ADCP_REPO fetch origin pull/8102/head:refs/remotes/pr/8102 --force
// (ADCP_REPO defaults to the adcp repo root, two levels up). If the checkout is missing, the PR
// numbers already in analysis/size-comparison.json are kept.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'analysis/size-comparison.json');
const ADCP_REPO = process.env.ADCP_REPO ?? path.resolve(ROOT, '../..');
const PR = 8102;

const lines = (file) => {
  const text = readFileSync(file, 'utf8');
  return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
};
const sum = (files) => ({ files: files.length, lines: files.reduce((n, f) => n + f.lines, 0), list: files });

// ---- #8102 ----------------------------------------------------------------------

// Which lane each #8102 schema file belongs to: the allowance lane is what the
// seller-adjustable-terms extension replaces; the offer lane is a mechanism that stays core in
// both designs; mixed files add one notification type per lane (and, in notification-type.json,
// reword unrelated descriptions).
const LANE = {
  'core/seller-adjustable-term.json': 'allowance',
  'core/applied-seller-adjustment.json': 'allowance',
  'core/allowance-applied-webhook.json': 'allowance',
  'enums/adjustment-direction.json': 'allowance',
  'media-buy/commercial-terms.json': 'allowance',
  'media-buy/get-media-buys-response.json': 'allowance',
  'core/account-change.json': 'allowance',
  'core/x-entity-types.json': 'allowance',
  'core/canonical-proposal.json': 'offer',
  'core/proposal-offered-webhook.json': 'offer',
  'enums/offer-reason.json': 'offer',
  'enums/proposal-initiator.json': 'offer',
  'enums/notification-type.json': 'mixed',
  'core/notification-config.json': 'mixed',
  'core/agent-notification-config.json': 'mixed',
  'index.json': 'mixed',
};

function prSide(previous) {
  const git = (...args) => execFileSync('git', ['-C', ADCP_REPO, ...args], { encoding: 'utf8' }).trim();
  try {
    git('rev-parse', '--verify', `refs/remotes/pr/${PR}`);
  } catch {
    if (previous?.pr_8102) return previous.pr_8102;
    throw new Error(`no refs/remotes/pr/${PR} in ${ADCP_REPO}; fetch it first (see the header)`);
  }
  const head = git('rev-parse', `pr/${PR}`);
  const base = git('merge-base', 'origin/main', `pr/${PR}`);
  const numstat = git('diff', '--numstat', `origin/main...pr/${PR}`)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ins, del, file] = l.split('\t');
      return { file, insertions: Number(ins), deletions: Number(del) };
    });
  const total = (rows) => ({
    files: rows.length,
    insertions: rows.reduce((n, r) => n + r.insertions, 0),
    deletions: rows.reduce((n, r) => n + r.deletions, 0),
  });
  const SRC = 'static/schemas/source/';
  const schema = numstat.filter((r) => r.file.startsWith(SRC)).map((r) => ({ ...r, file: r.file.slice(SRC.length), lane: LANE[r.file.slice(SRC.length)] ?? 'unclassified' }));
  const area = (r) => (r.file.startsWith(SRC) ? 'static/schemas/source' : r.file.startsWith('docs/') ? 'docs' : r.file.startsWith('tests/') ? 'tests' : r.file.startsWith('.changeset/') ? '.changeset' : 'other');
  const byArea = {};
  for (const r of numstat) (byArea[area(r)] ??= []).push(r);
  const byLane = {};
  for (const r of schema) (byLane[r.lane] ??= []).push(r);
  return {
    head,
    merge_base: base,
    origin_main: git('rev-parse', 'origin/main'),
    command: `git diff --shortstat origin/main...pr/${PR}`,
    shortstat: git('diff', '--shortstat', `origin/main...pr/${PR}`),
    whole_pr: total(numstat),
    by_area: Object.fromEntries(Object.entries(byArea).sort().map(([k, rows]) => [k, total(rows)])),
    static_schemas_source: {
      shortstat: git('diff', '--shortstat', `origin/main...pr/${PR}`, '--', 'static/schemas/source'),
      ...total(schema),
      by_lane: Object.fromEntries(Object.entries(byLane).sort().map(([k, rows]) => [k, total(rows)])),
      per_file: schema,
    },
  };
}

// ---- the extension packages ------------------------------------------------------

const PARTS = {
  schema_and_manifest: (dir) => ['schema.json', 'extension.json'].map((f) => path.join(dir, f)),
  spec: (dir) => [path.join(dir, 'spec.md')],
  storyboards: (dir) => readdirSync(path.join(dir, 'conformance')).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(dir, 'conformance', f)),
  reference_code: (dir) => [path.join(dir, 'index.mjs')],
  // Generated by the build or boilerplate: not authored, listed for completeness.
  generated_and_packaging: (dir) => ['dist/bundle.json', 'src/index.ts', 'extension.lock.json', 'package.json'].map((f) => path.join(dir, f)),
};

function packageSide() {
  const out = {};
  for (const name of readdirSync(path.join(ROOT, 'packages')).sort()) {
    const dir = path.join(ROOT, 'packages', name);
    if (!existsSync(path.join(dir, 'extension.json'))) continue;
    const manifest = JSON.parse(readFileSync(path.join(dir, 'extension.json'), 'utf8'));
    const parts = {};
    for (const [part, filesOf] of Object.entries(PARTS)) {
      parts[part] = sum(filesOf(dir).map((f) => ({ file: path.relative(dir, f), lines: lines(f) })));
    }
    const authored = ['schema_and_manifest', 'spec', 'storyboards', 'reference_code'];
    out[manifest.name] = {
      version: manifest.version,
      parts,
      authored_total: { files: authored.reduce((n, p) => n + parts[p].files, 0), lines: authored.reduce((n, p) => n + parts[p].lines, 0) },
    };
  }
  return out;
}

/** The numbers written last time, or null on a first run. */
function readPrevious() {
  try {
    return JSON.parse(readFileSync(OUT, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const previous = readPrevious();
const pr = prSide(previous);
const packages = packageSide();
const sat = packages['seller-adjustable-terms'];
const mg = packages['makegood-units'];
const coreDelta = JSON.parse(readFileSync(path.join(ROOT, 'core/patches.json'), 'utf8')).layers;
const coreFiles = new Set(coreDelta.flatMap((l) => l.patches.map((p) => p.file)));

const result = {
  $comment:
    'Like-for-like line counts. Rule: a line is a newline-terminated line (wc -l); for PR #8102 that is git insertions/deletions against the merge base. Package parts: schema_and_manifest = schema.json + extension.json; spec = spec.md; storyboards = conformance/*.yaml; reference_code = index.mjs; generated_and_packaging (dist/bundle.json, src/index.ts, extension.lock.json, package.json) is not authored and is excluded from authored_total. Generated by scripts/size-comparison.mjs.',
  generated_at: new Date().toISOString(),
  pr_8102: pr,
  extension_packages: packages,
  one_time_core_delta: {
    note: 'The core change this example makes once (core/patches.json): the extension points, unions, and kernel types that every extension shares. The count is not repeated per extension.',
    patch_file_lines: lines(path.join(ROOT, 'core/patches.json')),
    files_created: coreDelta.flatMap((l) => l.patches.filter((p) => p.op === 'create').map((p) => p.file)).length,
    files_touched: coreFiles.size,
  },
  like_for_like: {
    note: '#8102 allowance-lane schema files are what seller-adjustable-terms replaces; the offer lane (canonical-proposal, proposal-offered-webhook, offer-reason, proposal-initiator) stays core in both designs, and the 4 mixed files add one notification type per lane. #8102 also ships 642 test lines and 155 doc lines; the package counterparts are its storyboards and spec.',
    pr_8102_schema_source_insertions: pr.static_schemas_source.insertions,
    pr_8102_allowance_lane_insertions: pr.static_schemas_source.by_lane.allowance?.insertions,
    pr_8102_tests_insertions: pr.by_area.tests?.insertions,
    pr_8102_docs_insertions: pr.by_area.docs?.insertions,
    seller_adjustable_terms: {
      schema_and_manifest: sat.parts.schema_and_manifest.lines,
      spec: sat.parts.spec.lines,
      storyboards: sat.parts.storyboards.lines,
      reference_code: sat.parts.reference_code.lines,
      authored_total: sat.authored_total.lines,
    },
    makegood_units_authored_total: mg.authored_total.lines,
    core_files_changed: { pr_8102: pr.static_schemas_source.files, per_extension: 0 },
  },
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
console.log(`#8102 ${pr.head.slice(0, 10)}: ${pr.shortstat}; static/schemas/source: ${pr.static_schemas_source.shortstat}`);
for (const [name, p] of Object.entries(packages)) {
  console.log(`${name.padEnd(24)} ${p.version.padEnd(6)} ${Object.entries(p.parts).filter(([k]) => k !== 'generated_and_packaging').map(([k, v]) => `${k} ${v.lines}`).join(', ')}; authored ${p.authored_total.lines}`);
}
console.log(`wrote ${path.relative(ROOT, OUT)}`);
