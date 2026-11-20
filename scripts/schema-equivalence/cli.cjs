#!/usr/bin/env node
'use strict';

/**
 * Schema equivalence check: proves what a schema change does to the set of
 * valid payloads. See scripts/schema-equivalence/README.md.
 *
 *   node scripts/schema-equivalence/cli.cjs [--base REF] [--head REF] [options]
 *   node scripts/schema-equivalence/cli.cjs verify-build
 *
 * Exit status: 0 pass, 1 check failed, 2 usage or tool error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadFromRef, loadFromDir, git } = require('./lib/tree.cjs');
const { compare } = require('./lib/compare.cjs');
const yaml = require('js-yaml');
const { loadManifest, parseManifest, matchManifest, skeleton } = require('./lib/manifest.cjs');
const { collectCorpus, differential, sitesFromEntries, probeValues, TreeValidator } = require('./lib/corpus.cjs');
const { generateWitnesses } = require('./lib/witness.cjs');
const { formatText } = require('./lib/report.cjs');

// The repository whose refs are compared; --repo changes it (tests use a scratch repository).
let REPO = path.resolve(__dirname, '..', '..');
const DELTA_DIR = '.schema-deltas';

const USAGE = `Usage: node scripts/schema-equivalence/cli.cjs [verify-build] [options]

Compare the published schema roots at two refs (or two directories).

  --base REF            base ref (default: merge base of origin/main and HEAD)
  --head REF            head ref (default: HEAD)
  --base-dir DIR        compare directories instead; DIR plays static/schemas/source
  --head-dir DIR
  --dist-dir DIR        directory mode: plays dist/schemas for pinned refs
  --manifest FILE|auto  pass only if the differences equal this delta manifest;
                        "auto" uses the ${DELTA_DIR}/*.yaml files the head adds or changes
  --write-manifest FILE write a manifest skeleton for the current differences
  --no-rules            skip the class 2 rewrite rules
  --corpus              corpus differential for the roots that differ
  --corpus-all          corpus differential for every bound instance (cross-check)
  --corpus-dir DIR      directory mode: corpus files { "schema": "rel#ptr", "instance": ... }
                        or { "probe": ... } (a document of unbound values)
  --witness             generate one witness payload per manifest entry
  --json FILE           write the JSON report (- for stdout)
  --quiet               no text report
  --repo DIR            the git repository to read refs from (default: this one)

verify-build: compare static/schemas/source with dist/schemas/latest and
dist/schemas/latest/bundled (run \`npm run build:schemas\` first).`;

function displayPath(f) {
  const rel = path.relative(REPO, f);
  return rel.startsWith('..') ? f : rel;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function rootIds(tree, out) {
  for (const [rel, doc] of tree.files) if (doc && typeof doc.$id === 'string') out.set(rel, doc.$id);
}

function changedDeltaFiles(base, head) {
  const out = git(REPO, ['diff', '--name-only', '--diff-filter=AM', `${base}`, `${head}`, '--', DELTA_DIR]).toString('utf8');
  return out.split('\n').filter(f => /\.ya?ml$/.test(f));
}

/**
 * Directory-mode corpus: { "schema": "rel#ptr", "instance": ... } files are
 * bound instances; { "probe": ... } files are documents of unbound values.
 */
function loadDirCorpus(dir) {
  const bound = [];
  const probeDocs = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (typeof doc.schema === 'string') bound.push({ source: 'fixture', schema: doc.schema.includes('#') ? doc.schema : `${doc.schema}#`, label: name, instance: doc.instance });
    else if (doc.probe !== undefined) probeDocs.push({ label: name, doc: doc.probe });
    else throw new Error(`${name}: expected "schema" with "instance", or "probe"`);
  }
  return { bound, probes: probeValues(probeDocs) };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'base-dir': { type: 'string' },
      'head-dir': { type: 'string' },
      'dist-dir': { type: 'string' },
      manifest: { type: 'string' },
      'write-manifest': { type: 'string' },
      'no-rules': { type: 'boolean', default: false },
      corpus: { type: 'boolean', default: false },
      'corpus-all': { type: 'boolean', default: false },
      'corpus-dir': { type: 'string' },
      witness: { type: 'boolean', default: false },
      json: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      repo: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (values.repo) REPO = path.resolve(values.repo);
  const mode = positionals[0] || 'check';
  if (!['check', 'verify-build'].includes(mode)) fail(`unknown command ${mode}\n\n${USAGE}`);

  let base;
  let head;
  let pairs;
  let refs = null;
  if (mode === 'verify-build') {
    const built = path.join(REPO, 'dist', 'schemas', 'latest');
    if (!fs.existsSync(built)) fail('dist/schemas/latest does not exist; run `npm run build:schemas` first');
    base = loadFromDir(path.join(REPO, 'static', 'schemas', 'source'), path.join(REPO, 'dist', 'schemas'));
    head = loadFromDir(built, path.join(REPO, 'dist', 'schemas'));
    const { rootFiles } = require('./lib/compare.cjs');
    pairs = [];
    for (const rel of rootFiles(base)) {
      pairs.push({ name: rel, baseRel: rel, headRel: head.files.has(rel) ? rel : `missing/${rel}` });
      if (head.files.has(`bundled/${rel}`)) pairs.push({ name: `bundled/${rel}`, baseRel: rel, headRel: `bundled/${rel}` });
    }
  } else if (values['base-dir'] || values['head-dir']) {
    if (!values['base-dir'] || !values['head-dir']) fail('--base-dir and --head-dir go together');
    base = loadFromDir(path.resolve(values['base-dir']), values['dist-dir'] && path.resolve(values['dist-dir']));
    head = loadFromDir(path.resolve(values['head-dir']), values['dist-dir'] && path.resolve(values['dist-dir']));
  } else {
    const headRef = values.head || 'HEAD';
    const baseRef = values.base || git(REPO, ['merge-base', 'origin/main', headRef]).toString('utf8').trim();
    base = loadFromRef(REPO, baseRef);
    head = loadFromRef(REPO, headRef);
    refs = { base: base.commit, head: head.commit };
  }

  const result = compare(base, head, { rules: !values['no-rules'], pairs });
  const ids = new Map();
  rootIds(base, ids);
  rootIds(head, ids);
  for (const list of [result.entries, result.entriesWithoutRules, result.info]) {
    for (const e of list) e.root_id = ids.get(e.root) || `/schemas/${e.root}`;
  }

  const report = {
    base: { label: base.label, commit: base.commit },
    head: { label: head.label, commit: head.commit },
    compare: result,
    failures: [],
  };

  if (result.problems.length) report.failures.push(`${result.problems.length} unresolved or invalid schema locations`);

  let manifest = null;
  if (values.manifest) {
    let files;
    if (values.manifest === 'auto') {
      if (!refs) fail('--manifest auto needs git refs');
      files = changedDeltaFiles(refs.base, refs.head).map(f => path.join(REPO, f));
    } else files = [path.resolve(values.manifest)];
    const changes = [];
    for (const f of files) {
      // "auto" names files of the head ref: read them from its git objects,
      // so the head does not have to be checked out.
      const m = values.manifest === 'auto'
        ? parseManifest(yaml.load(git(REPO, ['show', `${refs.head}:${path.relative(REPO, f).split(path.sep).join('/')}`]).toString('utf8')), `${refs.head}:${path.relative(REPO, f)}`)
        : loadManifest(f);
      for (const c of m.changes) changes.push({ ...c, index: changes.length, file: displayPath(f) });
    }
    manifest = { changes, label: files.join(', ') };
    const match = matchManifest(result.entries, manifest);
    report.manifest = { files: files.map(displayPath), ...match };
    if (!match.ok) report.failures.push('the differences do not equal the manifest');
  } else if (result.entries.length) {
    report.failures.push(`${result.entries.length} undeclared difference entries`);
  }

  if (values['write-manifest']) fs.writeFileSync(values['write-manifest'], skeleton(result.entries));

  let corpus = null;
  let validators = null;
  const getValidators = () => validators || (validators = { base: new TreeValidator(base), head: new TreeValidator(head) });
  const timings = { compare_ms: result.timings.total_ms };
  if ((values.corpus && result.changedRoots.length) || values['corpus-all']) {
    const t0 = Date.now();
    if (refs) corpus = collectCorpus({ repo: REPO, commit: refs.head, baseTree: base, headTree: head });
    else {
      // Directory mode: the non-schema corpus comes from this repository's HEAD.
      corpus = collectCorpus({ repo: REPO, commit: git(REPO, ['rev-parse', 'HEAD']).toString('utf8').trim(), baseTree: base, headTree: head });
      if (values['corpus-dir']) {
        const dirCorpus = loadDirCorpus(path.resolve(values['corpus-dir']));
        corpus.bound.push(...dirCorpus.bound);
        corpus.probes.push(...dirCorpus.probes);
      }
    }
    timings.corpus_collect_ms = Date.now() - t0;
    report.corpus = await differential({
      baseTree: base,
      headTree: head,
      corpus,
      changedRoots: result.changedRoots,
      sites: sitesFromEntries(result.entries),
      all: values['corpus-all'],
      validators: getValidators(),
    });
    timings.corpus_ms = Date.now() - t0;
    const realChanges = report.corpus.changes.filter(ch => !ch.negative);
    if (realChanges.length) report.failures.push(`${realChanges.length} corpus instances change verdict`);
  } else if (values.corpus) {
    report.corpus_skipped = 'no root differs, so no corpus instance can change verdict';
  }

  if (values.witness) {
    if (!manifest) fail('--witness needs --manifest');
    const t0 = Date.now();
    report.witnesses = await generateWitnesses({ baseTree: base, headTree: head, manifest, match: report.manifest, corpus, validators: getValidators() });
    timings.witness_ms = Date.now() - t0;
    const missing = report.witnesses.filter(w => !w.ok);
    if (missing.length) report.failures.push(`${missing.length} manifest entries without a verified witness`);
  }

  report.timings = timings;
  report.ok = report.failures.length === 0;
  if (values.json) {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (values.json === '-') process.stdout.write(text);
    else fs.writeFileSync(values.json, text);
  }
  if (!values.quiet) process.stdout.write(`${formatText(report)}\n`);
  return report.ok ? 0 : 1;
}

// Set the exit code instead of calling process.exit(), which drops whatever a
// pipe has not yet taken of a large `--json -` report.
main().then((code) => {
  process.exitCode = code;
}, (err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 2;
});
