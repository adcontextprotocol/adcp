'use strict';

/**
 * The schema and compliance build cache, driven through its CLI:
 *
 *   node scripts/built-schemas.cjs ensure <target>...   build unless current
 *   node scripts/built-schemas.cjs status <target>      print fresh|stale <reason>
 *
 * Targets: `schemas` (scripts/build-schemas.cjs -> dist/schemas/latest) and
 * `compliance` (scripts/build-compliance.cjs -> dist/compliance/latest).
 *
 * The real builds run in a temporary copy of the repository's build inputs
 * (scripts, static/{schemas,compliance}/source, the md/mdx docs, package*.json,
 * the dist/schemas release listing) with node_modules symlinked to the real
 * one, so nothing here touches the working tree that other tests read. Each
 * target is built for real once and every case reuses that build; only the
 * rebuild and failure cases at the end run the build again.
 *
 * The read-set guard runs the first build with
 * tests/helpers/fs-access-tracer.cjs preloaded through NODE_OPTIONS, so the
 * build and every lint or helper it spawns record the files they read, list,
 * stat and write. A file the build reads that the digest does not cover would
 * let a stale tree pass as current; the guard fails on it.
 *
 * The work-count guards read the same trace. They count repeated work (how
 * often a build reads one source file or lists dist/schemas, and which process
 * runs each lint), so a build that redoes work per schema, per tool or per
 * lint fails on a count instead of on a clock.
 *
 * Every CLI run is asynchronous (runChild), so the runner's --test-timeout
 * bounds it, real builds included: node:test applies it to each hook and
 * each test. Nothing here asserts on wall-clock time.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { runChild } = require('./fixtures/storyboard-process-reaper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const TRACER = path.join(__dirname, 'helpers', 'fs-access-tracer.cjs');
const REAL_NODE_MODULES = fs.realpathSync(path.join(REPO_ROOT, 'node_modules'));
const TMP_ROOTS = [...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])];
// Kills any CLI run still alive when the file ends (a timed-out hook or test).
const teardown = { kills: [], after(kill) { this.kills.push(kill); } };

const TARGETS = {
  schemas: {
    script: 'scripts/build-schemas.cjs',
    builtDir: 'dist/schemas/latest',
    stamp: 'dist/schemas/latest/.build-inputs.sha256',
    lockDir: 'dist/schemas/.latest-build.lock',
    sentinel: 'dist/schemas/latest/index.json',
    outputs: ['dist/schemas/latest', 'skills/adcp-media-buy/schemas', 'skills/adcp-creative/schemas',
      'skills/adcp-signals/schemas', 'dist/schemas/index.json', 'dist/schemas/latest.json',
      'static/schemas/source/index.json'],
  },
  compliance: {
    script: 'scripts/build-compliance.cjs',
    builtDir: 'dist/compliance/latest',
    stamp: 'dist/compliance/latest/.build-inputs.sha256',
    lockDir: 'dist/compliance/.latest-build.lock',
    sentinel: 'dist/compliance/latest/index.json',
    outputs: ['dist/compliance/latest', 'docs'],
  },
};

// ------------------------------------------------------------------ fixture

let root; // the temporary repository copy (real path)
let traceRoot; // per-run trace directories live here

const posix = (p) => p.split(path.sep).join('/');
const abs = (rel) => path.join(root, rel);
const isDocsText = (name) => /\.mdx?$/.test(name);

/** Environment for every CLI run: no cache switches, lock hand-offs, tracing or test-runner state. */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(NODE_OPTIONS|NODE_TEST_CONTEXT|SOURCE_DATE_EPOCH|FS_TRACE_DIR|ADCP_BUILD_CACHE)$|_LOCK_HELD$/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * The release listing the builds read from dist/schemas: every semver
 * directory name, and in the 3.x releases an empty file for each source
 * schema path that some 3.x release ships (the symbol linker decides between
 * /schemas/v3/ and /schemas/latest/ links by existence alone). Contents are
 * never read, so the 7 GB tree is not copied.
 */
function mirrorReleaseListing() {
  const realDist = path.join(REPO_ROOT, 'dist', 'schemas');
  const versions = fs.readdirSync(realDist, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) fs.mkdirSync(abs(`dist/schemas/${version}`), { recursive: true });
  const threeX = versions.filter((version) => version.startsWith('3.'));
  const sourceDir = path.join(REPO_ROOT, 'static', 'schemas', 'source');
  for (const entry of fs.readdirSync(sourceDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const rel = posix(path.relative(sourceDir, path.join(entry.parentPath, entry.name)));
    const release = threeX.find((version) => fs.existsSync(path.join(realDist, version, rel)));
    if (!release) continue;
    fs.mkdirSync(path.dirname(abs(`dist/schemas/${release}/${rel}`)), { recursive: true });
    fs.writeFileSync(abs(`dist/schemas/${release}/${rel}`), '');
  }
}

function makeRepoCopy() {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-cache-repo-')));
  traceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-cache-trace-')));
  for (const rel of ['scripts', 'static/schemas/source', 'static/compliance/source']) {
    fs.cpSync(path.join(REPO_ROOT, rel), abs(rel), { recursive: true });
  }
  fs.cpSync(path.join(REPO_ROOT, 'docs'), abs('docs'), {
    recursive: true,
    filter: (source) => fs.statSync(source).isDirectory() || isDocsText(source),
  });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO_ROOT, file), abs(file));
  fs.symlinkSync(REAL_NODE_MODULES, abs('node_modules'), 'dir');
  mirrorReleaseListing();
}

// ---------------------------------------------------------------------- CLI

let traceCount = 0;

/** Runs the cache CLI in the copy. With trace: true, every Node process in the run records its file accesses. */
async function cli(args, { env = cleanEnv(), trace = false } = {}) {
  let traceDir = null;
  const runEnv = { ...env };
  if (trace) {
    traceCount += 1;
    traceDir = path.join(traceRoot, `run-${traceCount}`);
    fs.mkdirSync(traceDir);
    runEnv.NODE_OPTIONS = `--require ${TRACER}`;
    runEnv.FS_TRACE_DIR = traceDir;
  }
  const result = await runChild(teardown, process.execPath, [abs('scripts/built-schemas.cjs'), ...args], {
    cwd: root,
    env: runEnv,
  });
  const run = {
    args,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    trace: traceDir ? readTrace(traceDir) : null,
  };
  run.cacheLines = run.stderr.split('\n').filter((line) => line.startsWith('build-cache:'));
  run.describe = () => `node scripts/built-schemas.cjs ${args.join(' ')} -> exit ${run.code}${run.signal ? ` (${run.signal})` : ''}\n` +
    `--- stdout (tail)\n${run.stdout.slice(-3000)}\n--- stderr (tail)\n${run.stderr.slice(-3000)}`;
  return run;
}

/** A trace: one entry per access, { pid, op, file } with absolute paths. */
function readTrace(dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const pid = Number(name.replace(/\.log$/, ''));
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      entries.push({ pid, op: line.slice(0, tab), file: line.slice(tab + 1) });
    }
  }
  return entries;
}

async function status(target, env) {
  const run = await cli(['status', target], env ? { env } : {});
  assert.equal(run.code, 0, `status exits 0\n${run.describe()}`);
  const match = /^(fresh|stale)\b[ \t:;-]*(.*)$/m.exec(run.stdout);
  assert.ok(match, `status prints fresh or stale on stdout\n${run.describe()}`);
  return { state: match[1], reason: match[2].trim(), run };
}

async function assertFresh(target, why, env) {
  const result = await status(target, env);
  assert.equal(result.state, 'fresh', `${target} is fresh ${why}\n${result.run.describe()}`);
}

async function assertStale(target, why, env) {
  const result = await status(target, env);
  assert.equal(result.state, 'stale', `${target} is stale ${why}\n${result.run.describe()}`);
  assert.ok(result.reason.length > 0, `a stale status names its reason\n${result.run.describe()}`);
  return result;
}

const scriptPattern = (script) => path.basename(script).replace(/\./g, '\\.');

function hitLine(target) {
  const { builtDir, script } = TARGETS[target];
  return new RegExp(`^build-cache: ${builtDir.replace(/\//g, '\\/')} current \\(inputs ([0-9a-f]{12})\\); skipped (?:scripts/)?${scriptPattern(script)}$`);
}

function missLine(target) {
  return new RegExp(`^build-cache: (.+); running (?:scripts/)?${scriptPattern(TARGETS[target].script)}$`);
}

// ------------------------------------------------------------------- edits

/** Each edit changes one build input in the copy; revert() restores it byte for byte. */
const edits = {
  append(rel, text = '\n') {
    const original = fs.readFileSync(abs(rel));
    fs.appendFileSync(abs(rel), text);
    return () => fs.writeFileSync(abs(rel), original);
  },
  addFile(rel, content) {
    assert.equal(fs.existsSync(abs(rel)), false, `${rel} must not exist before the edit`);
    let created = abs(rel);
    while (!fs.existsSync(path.dirname(created))) created = path.dirname(created);
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), content);
    return () => fs.rmSync(created, { recursive: true });
  },
  addDir(rel) {
    assert.equal(fs.existsSync(abs(rel)), false, `${rel} must not exist before the edit`);
    fs.mkdirSync(abs(rel));
    return () => fs.rmdirSync(abs(rel));
  },
  /**
   * node_modules becomes a real directory whose entries are symlinks into the
   * real node_modules (as after `npm link`): same contents, all linked.
   */
  linkDependencies() {
    const link = abs('node_modules');
    const parked = abs('node_modules.parked-link');
    fs.renameSync(link, parked);
    fs.mkdirSync(link);
    const created = [];
    for (const name of fs.readdirSync(REAL_NODE_MODULES)) {
      fs.symlinkSync(path.join(REAL_NODE_MODULES, name), path.join(link, name));
      created.push(path.join(link, name));
    }
    return () => {
      for (const entry of created) fs.unlinkSync(entry);
      fs.rmdirSync(link);
      fs.renameSync(parked, link);
    };
  },
};

/** status: fresh -> edit -> stale -> revert -> fresh. */
async function assertInputClass(target, edit, { env } = {}) {
  await assertFresh(target, 'before the edit');
  let staleEnv;
  let revert = () => {};
  if (edit) revert = edit();
  try {
    staleEnv = env ? cleanEnv(env) : undefined;
    return await assertStale(target, 'after the edit', staleEnv);
  } finally {
    revert();
    await assertFresh(target, 'after reverting the edit');
  }
}

// --------------------------------------------------------- output snapshots

function hashFiles(rel, accept = () => true) {
  const out = new Map();
  const full = abs(rel);
  if (!fs.existsSync(full)) return out;
  if (fs.statSync(full).isFile()) {
    out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    return out;
  }
  for (const entry of fs.readdirSync(full, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !accept(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    out.set(posix(path.relative(root, file)), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  }
  return out;
}

function snapshotOutputs(target) {
  const all = new Map();
  for (const rel of TARGETS[target].outputs) {
    for (const [file, digest] of hashFiles(rel, rel === 'docs' ? isDocsText : () => true)) all.set(file, digest);
  }
  return all;
}

function changedFiles(before, after) {
  const changed = [];
  for (const [file, digest] of before) if (after.get(file) !== digest) changed.push(file);
  for (const file of after.keys()) if (!before.has(file)) changed.push(file);
  return changed.sort();
}

// --------------------------------------------------------------- read sets

const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
const LISTING_OPS = new Set(['readdir', 'stat']);
const CONTENT_OPS = new Set(['read', 'load']);

/**
 * The declared input set of each target (design: tp-jyw.22 plan items 2-3),
 * as a predicate over a repo-relative path and an access op. Inputs may be
 * read in any way; listings may only be listed or stat'ed.
 */
const INPUTS = {
  schemas(rel, op) {
    if (['package.json', 'package-lock.json', 'scripts/build-schemas.cjs', 'scripts/mcp-schema-projection.cjs',
      'scripts/built-schemas.cjs'].includes(rel)) return true;
    if (under(rel, 'static/schemas/source') || under(rel, 'static/compliance/source')) return true;
    // The semver directory listing of dist/schemas (feeds the tracked discovery files).
    return LISTING_OPS.has(op) && (rel === 'dist/schemas' || /^dist\/schemas\/[^/]+$/.test(rel));
  },
  compliance(rel, op) {
    if (['package.json', 'package-lock.json'].includes(rel)) return true;
    if (under(rel, 'scripts')) return true; // each script read is checked against the digest below
    if (under(rel, 'static/schemas/source') || under(rel, 'static/compliance/source')) return true;
    if (under(rel, 'docs')) return LISTING_OPS.has(op) || isDocsText(rel);
    // Released schema paths decide v3 vs latest symbol links: listing only.
    // The digest covers the release directory names; the trees below them
    // are immutable release artifacts.
    return LISTING_OPS.has(op) && under(rel, 'dist/schemas');
  },
};

/** Outputs a build may read back, write or remove. */
const OUTPUTS = {
  schemas(rel) {
    return under(rel, 'dist/schemas/latest') || under(rel, 'dist/schemas/.latest-build.lock') ||
      ['dist', 'dist/schemas', 'dist/schemas/index.json', 'dist/schemas/latest.json', 'skills',
        'static/schemas/source/index.json'].includes(rel) ||
      /^skills\/adcp-[a-z-]+(\/schemas(\/.*)?)?$/.test(rel);
  },
  compliance(rel) {
    return under(rel, 'dist/compliance/latest') || under(rel, 'dist/compliance/.latest-build.lock') ||
      ['dist', 'dist/compliance'].includes(rel) || (under(rel, 'docs') && (isDocsText(rel) || !path.extname(rel)));
  },
};

/** Why an access falls outside the target's declared set, or null when it is allowed. */
function disallowed(target, { op, file }, temporaries) {
  const inRoot = file === root || file.startsWith(`${root}/`);
  if (!inRoot) {
    if (file === REAL_NODE_MODULES || file.startsWith(`${REAL_NODE_MODULES}/`)) return null;
    if (TMP_ROOTS.some((tmp) => file.startsWith(`${tmp}/`))) return null;
    if (op === 'stat' && root.startsWith(`${file}/`)) return null; // an ancestor of the repo root
    return 'outside the repository, node_modules and the temp dir';
  }
  const rel = posix(path.relative(root, file));
  if (rel === '') return op === 'stat' ? null : 'repository root listed or read';
  if (under(rel, 'node_modules')) {
    let real;
    try { real = fs.realpathSync(file); } catch { return null; } // a probe for a missing module
    return real === REAL_NODE_MODULES || real.startsWith(`${REAL_NODE_MODULES}/`) ? null : `node_modules entry resolves to ${real}`;
  }
  if (op === 'write') return OUTPUTS[target](rel) || temporaries.has(file) ? null : 'written outside the outputs';
  if (INPUTS[target](rel, op) || OUTPUTS[target](rel) || temporaries.has(file)) return null;
  return CONTENT_OPS.has(op) ? 'read but not a declared input' : 'listed or stat-ed but not a declared input';
}

/** Files the run created and that are gone afterwards (its own scratch files). */
function temporariesOf(trace) {
  return new Set(trace.filter((e) => e.op === 'write' && e.file.startsWith(`${root}/`) && !fs.existsSync(e.file)).map((e) => e.file));
}

function violations(target, trace) {
  const temporaries = temporariesOf(trace);
  const out = new Map();
  for (const entry of trace) {
    const reason = disallowed(target, entry, temporaries);
    if (reason) out.set(`${entry.op} ${entry.file}`, reason);
  }
  return [...out].map(([access, reason]) => `${access}: ${reason}`);
}

/**
 * A cache hit may read the declared inputs (to digest them), stat its stamp
 * and outputs' parents, and lstat node_modules entries (the linked-dependency
 * check); it reads no output and nothing outside the inputs.
 */
function hitRunMayAccess(target, entry) {
  if (entry.op === 'write') return false;
  const reason = disallowed(target, entry, new Set());
  if (reason !== null) return false;
  if (!entry.file.startsWith(`${root}/`)) return true;
  const rel = posix(path.relative(root, entry.file));
  if (under(rel, 'node_modules')) return true;
  return INPUTS[target](rel, entry.op) || (entry.op === 'stat' && OUTPUTS[target](rel));
}

function relContentReads(trace) {
  return trace.filter((e) => CONTENT_OPS.has(e.op) && e.file.startsWith(`${root}/`) && !e.file.startsWith(`${abs('node_modules')}/`))
    .map((e) => posix(path.relative(root, e.file)));
}

// ------------------------------------------------------------- work counts

/**
 * The most times one source file may be read by the schemas build process.
 * Each pass over the source tree reads a file at most once, and a file can be
 * reached by these passes:
 *
 *   1  the input digest taken at the start of the build (withBuildLock)
 *   1  the source registry update (index.json only)
 *   3  the three source lints (idempotency key, vendor metric uniqueness,
 *      error-code enumMetadata)
 *   1  copy-and-transform into dist/schemas/latest
 *   2  the manifest: discoverTools, plus the mutating-request check and the
 *      task-type and error-code reads
 *   2  extensions: discovery, then the extension-meta copy
 *   1  bundling, with one parsed-document map for the whole run
 *   1  MCP projection, with one source cache for the six projections
 *
 * The sum, 12, is the ceiling for a file that every pass touches. A pass that
 * reads a file again per root schema, per tool or per profile goes far past
 * it.
 */
const MAX_SCHEMA_SOURCE_READS = 12;
// The most times one process may list dist/schemas. The cache CLI digests the
// release listing twice (before and after it takes the lock). The build lists
// it once for its own digest, and the symbol linker once for release
// membership; that is still two if the linker runs in the build's process.
const MAX_RELEASE_LISTINGS_PER_PROCESS = 2;

/** Counts of `key(entry)` over the entries, highest first. */
function countBy(entries, key) {
  const counts = new Map();
  for (const entry of entries) {
    const k = key(entry);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/** The top `n` counts as indented lines, for failure messages. */
function topCounts(sorted, n = 8, label = String) {
  return sorted.slice(0, n).map(([k, count]) => `  ${String(count).padStart(6)}  ${label(k)}`).join('\n');
}

/** The pids that loaded the target's build script. */
function buildPidsOf(trace, script) {
  return new Set(trace.filter((e) => e.op === 'load' && e.file === abs(script)).map((e) => e.pid));
}

/** A label for a traced process: its pid and the first repository module it loaded (its main script). */
function processLabel(trace) {
  const main = new Map();
  for (const e of trace) {
    if (e.op !== 'load' || main.has(e.pid) || !e.file.startsWith(`${root}/`) || e.file.startsWith(`${abs('node_modules')}/`)) continue;
    main.set(e.pid, posix(path.relative(root, e.file)));
  }
  return (pid) => `pid ${pid} (${main.get(pid) ?? 'no repository module'})`;
}

// --------------------------------------------------------------- the cases

const firstBuild = {};

before(() => {
  makeRepoCopy();
});

after(() => {
  for (const kill of teardown.kills) kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (traceRoot) fs.rmSync(traceRoot, { recursive: true, force: true });
});

for (const target of Object.keys(TARGETS)) {
  const { script, stamp, lockDir } = TARGETS[target];

  describe(`build cache: ${target}`, () => {
    before(async () => {
      // The one real build of this target, traced for the read-set guard.
      firstBuild[target] = await cli(['ensure', target], { trace: true });
      // Builds that rewrite their own inputs (symbol links in docs, the source
      // registry on a version bump) are stamped with the digest taken at their
      // start, so they converge after one more build. Settle that here; when
      // nothing was rewritten this is a cache hit.
      await cli(['ensure', target]);
    });

    it(`the first ensure ${target} reports a miss, runs ${script} and stamps the result`, async () => {
      const run = firstBuild[target];
      assert.equal(run.code, 0, run.describe());
      assert.equal(run.cacheLines.length, 1, `one build-cache line\n${run.describe()}`);
      assert.match(run.cacheLines[0], missLine(target), run.describe());
      assert.match(fs.readFileSync(abs(stamp), 'utf8'), /^[0-9a-f]{64}\n?$/, `${stamp} holds a sha256 digest`);
      assert.equal(fs.existsSync(abs(lockDir)), false, `${lockDir} is released`);
      await assertFresh(target, 'after the build');
    });

    it(`read-set guard: the ${target} build reads only its declared inputs, its outputs, the temp dir and node_modules`, () => {
      const trace = firstBuild[target].trace;
      const buildPids = new Set(trace.filter((e) => e.op === 'load' && e.file === abs(script)).map((e) => e.pid));
      assert.ok(buildPids.size > 0, `the traced run loaded ${script} (the build ran under the tracer)\n${firstBuild[target].describe()}`);
      const reads = relContentReads(trace);
      for (const dir of ['static/schemas/source', 'static/compliance/source']) {
        assert.ok(reads.some((rel) => under(rel, dir)), `the build read files under ${dir}`);
      }
      assert.deepEqual(violations(target, trace), [], 'every access is covered by the target input set or is an output');
    });

    it(`read-set guard: editing any script the ${target} build reads makes ${target} stale`, async () => {
      const scripts = [...new Set(relContentReads(firstBuild[target].trace).filter((rel) => under(rel, 'scripts')))].sort();
      assert.ok(scripts.includes(script), `the build read ${script}; read: ${JSON.stringify(scripts)}`);
      await assertFresh(target, 'before editing scripts');
      // status hashes the path and content of every input file it reads, so a
      // script whose content one traced status run reads is one whose edit
      // makes the target stale (some 80 scripts for compliance, one status
      // run instead of one per script).
      const digestRun = await cli(['status', target], { trace: true });
      assert.equal(digestRun.code, 0, digestRun.describe());
      const digested = new Set(relContentReads(digestRun.trace.filter((e) => e.op === 'read')));
      assert.deepEqual(scripts.filter((rel) => !digested.has(rel)), [], 'status hashes every script the build reads');
      // End to end through the CLI: the build script and the first other
      // script the build reads.
      for (const rel of [script, scripts.find((other) => other !== script)].filter(Boolean)) {
        const revert = edits.append(rel, '\n// build-cache test edit\n');
        try {
          await assertStale(target, `after editing ${rel}, which the build reads`);
        } finally {
          revert();
        }
      }
      await assertFresh(target, 'after reverting every script edit');
    });

    if (target === 'schemas') {
      it(`work-count guard: the schemas build reads each file under static/schemas/source at most ${MAX_SCHEMA_SOURCE_READS} times`, () => {
        const trace = firstBuild.schemas.trace;
        // Only the build process counts: the cache CLI's digest runs before
        // the build and is part of the cache key, not of the build.
        const buildPids = buildPidsOf(trace, script);
        assert.ok(buildPids.size > 0, `the traced run loaded ${script}\n${firstBuild.schemas.describe()}`);
        const sourceDir = `${abs('static/schemas/source')}/`;
        const reads = trace.filter((e) => buildPids.has(e.pid) && CONTENT_OPS.has(e.op) && e.file.startsWith(sourceDir));
        assert.ok(reads.length > 0, 'the build read files under static/schemas/source');
        const perFile = countBy(reads, (e) => posix(path.relative(root, e.file)));
        const over = perFile.filter(([, count]) => count > MAX_SCHEMA_SOURCE_READS);
        assert.deepEqual(
          over.map(([rel]) => rel),
          [],
          `${over.length} of ${perFile.length} source files are read more than ${MAX_SCHEMA_SOURCE_READS} times ` +
            `(${reads.length} reads in all); most read:\n${topCounts(perFile)}`,
        );
      });
    }

    if (target === 'compliance') {
      it(`work-count guard: no process of the compliance build lists dist/schemas more than ${MAX_RELEASE_LISTINGS_PER_PROCESS} times`, () => {
        const trace = firstBuild.compliance.trace;
        const releaseListing = abs('dist/schemas');
        const listings = trace.filter((e) => e.op === 'readdir' && e.file === releaseListing);
        assert.ok(listings.length > 0, 'the run lists dist/schemas (the release listing is a compliance input)');
        const perPid = countBy(listings, (e) => e.pid);
        const over = perPid.filter(([, count]) => count > MAX_RELEASE_LISTINGS_PER_PROCESS);
        const label = processLabel(trace);
        assert.deepEqual(
          over.map(([pid]) => label(pid)),
          [],
          `processes that list dist/schemas more than ${MAX_RELEASE_LISTINGS_PER_PROCESS} times:\n${topCounts(perPid, 8, label)}`,
        );
      });

      it('work-count guard: every scripts/lint-*.cjs the compliance build runs is loaded in the build process, not in a child', () => {
        const trace = firstBuild.compliance.trace;
        const buildPids = buildPidsOf(trace, script);
        assert.equal(buildPids.size, 1, `one process loaded ${script}; pids: ${[...buildPids]}\n${firstBuild.compliance.describe()}`);
        const [buildPid] = buildPids;
        const lintLoads = trace.filter((e) => e.op === 'load' && /^scripts\/lint-[^/]+\.cjs$/.test(posix(path.relative(root, e.file))));
        const lints = [...new Set(lintLoads.map((e) => posix(path.relative(root, e.file))))].sort();
        assert.ok(lints.length > 0, `the build loaded at least one scripts/lint-*.cjs\n${firstBuild.compliance.describe()}`);
        const inBuild = new Set(lintLoads.filter((e) => e.pid === buildPid).map((e) => posix(path.relative(root, e.file))));
        const label = processLabel(trace);
        const elsewhere = new Map();
        for (const e of lintLoads.filter((entry) => entry.pid !== buildPid)) {
          if (!elsewhere.has(e.pid)) elsewhere.set(e.pid, new Set());
          elsewhere.get(e.pid).add(posix(path.relative(root, e.file)));
        }
        const elsewhereLines = [...elsewhere].slice(0, 8)
          .map(([pid, loaded]) => `  ${label(pid)} loads ${[...loaded].sort().join(', ')}`).join('\n');
        assert.deepEqual(
          lints.filter((rel) => !inBuild.has(rel)),
          [],
          `${lints.length - inBuild.size} of ${lints.length} lints are not loaded in the build process ${label(buildPid)}; ` +
            `${elsewhere.size} other processes load lints, first few:\n${elsewhereLines}`,
        );
        assert.deepEqual([...elsewhere.keys()].map(label), [], 'no process other than the build loads a lint');
      });
    }

    describe(`status ${target}: fresh -> edit -> stale -> revert -> fresh, per input class`, () => {
      const classes = {
        schemas: {
          'schema source file': () => edits.append('static/schemas/source/core/account.json'),
          'new file in the schema source tree': () => edits.addFile('static/schemas/source/core/zz-build-cache-new.json', '{}\n'),
          'compliance source file': () => edits.append('static/compliance/source/universal/account-requests.yaml'),
          'build script': () => edits.append('scripts/build-schemas.cjs', '\n// edit\n'),
          'required script (mcp-schema-projection.cjs)': () => edits.append('scripts/mcp-schema-projection.cjs', '\n// edit\n'),
          'package.json': () => edits.append('package.json'),
          'package-lock.json': () => edits.append('package-lock.json'),
          'new dist/schemas/<semver> directory': () => edits.addDir('dist/schemas/99.0.0'),
        },
        compliance: {
          'schema source file': () => edits.append('static/schemas/source/core/account.json'),
          'compliance source file': () => edits.append('static/compliance/source/universal/account-requests.yaml'),
          'new file in the compliance source tree': () => edits.addFile('static/compliance/source/universal/zz-build-cache-new.yaml', 'id: zz_build_cache_new\n'),
          'build script': () => edits.append('scripts/build-compliance.cjs', '\n// edit\n'),
          'required script (a spawned lint)': () => edits.append('scripts/lint-storyboard-scoping.cjs', '\n// edit\n'),
          'required script (build-schemas.cjs, imported by the symbol linker)': () => edits.append('scripts/build-schemas.cjs', '\n// edit\n'),
          'package.json': () => edits.append('package.json'),
          'package-lock.json': () => edits.append('package-lock.json'),
          'docs mdx file': () => edits.append('docs/protocol/architecture.mdx'),
          'new docs mdx file': () => edits.addFile('docs/protocol/zz-build-cache-new.mdx', '# New\n'),
          // The symbol linker checks which 3.x release ships a schema. Released
          // trees are immutable (scripts/check-immutable-release-artifacts.cjs),
          // so a new release directory is the only way that answer changes.
          'new dist/schemas/<semver> release directory': () => edits.addDir('dist/schemas/99.0.0'),
        },
      }[target];

      for (const [name, edit] of Object.entries(classes)) {
        it(name, async () => {
          await assertInputClass(target, edit);
        });
      }

      it('SOURCE_DATE_EPOCH', async () => {
        await assertInputClass(target, null, { env: { SOURCE_DATE_EPOCH: '1700000000' } });
      });

      it('linked dependency in node_modules', async () => {
        const result = await assertInputClass(target, edits.linkDependencies);
        assert.match(result.reason, /linked dependency/, result.run.describe());
      });
    });

    it(`ensure ${target} on unchanged inputs prints the hit line, spawns no build, writes nothing and leaves the outputs byte-identical`, async () => {
      await assertFresh(target, 'before the hit');
      const stampBefore = fs.readFileSync(abs(stamp), 'utf8');
      const outputsBefore = snapshotOutputs(target);

      const run = await cli(['ensure', target], { trace: true });

      assert.equal(run.code, 0, run.describe());
      assert.equal(run.cacheLines.length, 1, `one build-cache line\n${run.describe()}`);
      const hit = hitLine(target).exec(run.cacheLines[0]);
      assert.ok(hit, `hit line, got ${JSON.stringify(run.cacheLines[0])}\n${run.describe()}`);
      assert.equal(hit[1], stampBefore.trim().slice(0, 12), 'the hit line names the stamped digest');
      assert.equal(fs.readFileSync(abs(stamp), 'utf8'), stampBefore, 'stamp unchanged');
      assert.deepEqual(changedFiles(outputsBefore, snapshotOutputs(target)), [], 'output tree byte-identical');

      const pids = new Set(run.trace.map((e) => e.pid));
      assert.equal(pids.size, 1, `the hit run is one process (no build spawned); pids: ${[...pids]}`);
      assert.equal(run.trace.some((e) => e.op === 'load' && e.file === abs(script)), false, `${script} is not loaded`);
      assert.deepEqual(run.trace.filter((e) => e.op === 'write').map((e) => e.file), [], 'the hit run writes nothing');
      const ownModules = new Set(run.trace.filter((e) => e.op === 'load').map((e) => e.file));
      const stray = run.trace
        .filter((e) => e.file !== abs(stamp) && !ownModules.has(e.file) && !hitRunMayAccess(target, e))
        .map((e) => `${e.op} ${e.file}`);
      assert.deepEqual([...new Set(stray)], [], 'the hit run reads only the inputs, the stamp and its own modules');
      const readCount = run.trace.filter((e) => e.op === 'read').length;
      const buildReadCount = firstBuild[target].trace.filter((e) => e.op === 'read').length;
      assert.ok(readCount < buildReadCount, `hit run reads (${readCount}) fewer files than the build (${buildReadCount})`);
    });
  });
}

describe('build cache: several targets', () => {
  it('ensure schemas compliance prints one hit line per target, in order, when both are current', async () => {
    const run = await cli(['ensure', 'schemas', 'compliance']);
    assert.equal(run.code, 0, run.describe());
    assert.equal(run.cacheLines.length, 2, run.describe());
    assert.match(run.cacheLines[0], hitLine('schemas'), run.describe());
    assert.match(run.cacheLines[1], hitLine('compliance'), run.describe());
  });
});

describe('build cache: rebuilds and failed builds', () => {
  // Compliance first, through a compliance-only input (docs), so it starts
  // fresh; the schema source edit after it also makes compliance stale,
  // which the failure cases below do not depend on.
  const rebuildEdits = {
    compliance: 'docs/protocol/architecture.mdx',
    schemas: 'static/schemas/source/core/account.json',
  };

  for (const target of Object.keys(rebuildEdits)) {
    const { stamp, sentinel } = TARGETS[target];

    it(`ensure ${target} after one input edit reports a miss, runs the build and stamps the new inputs`, async () => {
      await assertFresh(target, 'before the edit');
      assert.ok(fs.existsSync(abs(sentinel)), `${sentinel} exists after the first build`);
      const stampBefore = fs.readFileSync(abs(stamp), 'utf8');
      edits.append(rebuildEdits[target]); // kept: the rebuilt tree is the new baseline
      fs.rmSync(abs(sentinel)); // an output only a real build writes back

      const run = await cli(['ensure', target]);

      assert.equal(run.code, 0, run.describe());
      assert.equal(run.cacheLines.length, 1, run.describe());
      assert.match(run.cacheLines[0], missLine(target), run.describe());
      assert.ok(fs.existsSync(abs(sentinel)), `the build ran and rewrote ${sentinel}`);
      assert.notEqual(fs.readFileSync(abs(stamp), 'utf8'), stampBefore, 'the stamp records the new inputs');
      await assertFresh(target, 'after the rebuild');
    });
  }

  for (const [target, broken] of Object.entries({
    schemas: { rel: 'static/schemas/source/core/zz-build-cache-broken.json', content: '{ "broken": \n' },
    compliance: { rel: 'static/compliance/source/universal/zz-build-cache-broken.yaml', content: 'id: zz_broken\nsteps: [unclosed\n' },
  })) {
    const { lockDir, script } = TARGETS[target];

    it(`a failing ${target} build (broken source) exits with the build's status from ensure and from ${script}, and leaves no ${lockDir}`, async () => {
      edits.addFile(broken.rel, broken.content); // kept: last case for this target

      const ensured = await cli(['ensure', target]);
      assert.equal(ensured.cacheLines.length, 1, ensured.describe());
      assert.match(ensured.cacheLines[0], missLine(target), ensured.describe());
      assert.notEqual(ensured.code, 0, `ensure fails when the build fails\n${ensured.describe()}`);
      assert.equal(fs.existsSync(abs(lockDir)), false, `ensure leaves no ${lockDir}`);

      const explicit = await runChild(teardown, process.execPath, [abs(script)], { cwd: root, env: cleanEnv() });
      assert.equal(explicit.status, 1, `node ${script} exits 1 on the broken source\n${(explicit.stderr ?? '').slice(-2000)}`);
      assert.equal(ensured.code, explicit.status, 'ensure exits with the build exit status');
      assert.equal(fs.existsSync(abs(lockDir)), false, `the explicit build leaves no ${lockDir}`);
      await assertStale(target, 'after a failed build');
    });
  }
});
