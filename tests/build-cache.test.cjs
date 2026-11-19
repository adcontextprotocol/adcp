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
 * Nothing here asserts on wall-clock time.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const TRACER = path.join(__dirname, 'helpers', 'fs-access-tracer.cjs');
const REAL_NODE_MODULES = fs.realpathSync(path.join(REPO_ROOT, 'node_modules'));
const TMP_ROOTS = [...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])];
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

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
function cli(args, { env = cleanEnv(), trace = false } = {}) {
  let traceDir = null;
  const runEnv = { ...env };
  if (trace) {
    traceCount += 1;
    traceDir = path.join(traceRoot, `run-${traceCount}`);
    fs.mkdirSync(traceDir);
    runEnv.NODE_OPTIONS = `--require ${TRACER}`;
    runEnv.FS_TRACE_DIR = traceDir;
  }
  const result = spawnSync(process.execPath, [abs('scripts/built-schemas.cjs'), ...args], {
    cwd: root,
    env: runEnv,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: BUILD_TIMEOUT_MS,
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

function status(target, env) {
  const run = cli(['status', target], env ? { env } : {});
  assert.equal(run.code, 0, `status exits 0\n${run.describe()}`);
  const match = /^(fresh|stale)\b[ \t:;-]*(.*)$/m.exec(run.stdout);
  assert.ok(match, `status prints fresh or stale on stdout\n${run.describe()}`);
  return { state: match[1], reason: match[2].trim(), run };
}

function assertFresh(target, why, env) {
  const result = status(target, env);
  assert.equal(result.state, 'fresh', `${target} is fresh ${why}\n${result.run.describe()}`);
}

function assertStale(target, why, env) {
  const result = status(target, env);
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
function assertInputClass(target, edit, { env } = {}) {
  assertFresh(target, 'before the edit');
  let staleEnv;
  let revert = () => {};
  if (edit) revert = edit();
  try {
    staleEnv = env ? cleanEnv(env) : undefined;
    return assertStale(target, 'after the edit', staleEnv);
  } finally {
    revert();
    assertFresh(target, 'after reverting the edit');
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

// --------------------------------------------------------------- the cases

const firstBuild = {};

before(() => {
  makeRepoCopy();
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (traceRoot) fs.rmSync(traceRoot, { recursive: true, force: true });
});

for (const target of Object.keys(TARGETS)) {
  const { script, stamp, lockDir } = TARGETS[target];

  describe(`build cache: ${target}`, () => {
    before(() => {
      // The one real build of this target, traced for the read-set guard.
      firstBuild[target] = cli(['ensure', target], { trace: true });
      // Builds that rewrite their own inputs (symbol links in docs, the source
      // registry on a version bump) are stamped with the digest taken at their
      // start, so they converge after one more build. Settle that here; when
      // nothing was rewritten this is a cache hit.
      cli(['ensure', target]);
    });

    it(`the first ensure ${target} reports a miss, runs ${script} and stamps the result`, () => {
      const run = firstBuild[target];
      assert.equal(run.code, 0, run.describe());
      assert.equal(run.cacheLines.length, 1, `one build-cache line\n${run.describe()}`);
      assert.match(run.cacheLines[0], missLine(target), run.describe());
      assert.match(fs.readFileSync(abs(stamp), 'utf8'), /^[0-9a-f]{64}\n?$/, `${stamp} holds a sha256 digest`);
      assert.equal(fs.existsSync(abs(lockDir)), false, `${lockDir} is released`);
      assertFresh(target, 'after the build');
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

    it(`read-set guard: editing any script the ${target} build reads makes ${target} stale`, () => {
      const scripts = [...new Set(relContentReads(firstBuild[target].trace).filter((rel) => under(rel, 'scripts')))].sort();
      assert.ok(scripts.includes(script), `the build read ${script}; read: ${JSON.stringify(scripts)}`);
      assertFresh(target, 'before editing scripts');
      for (const rel of scripts) {
        const revert = edits.append(rel, '\n// build-cache test edit\n');
        try {
          assertStale(target, `after editing ${rel}, which the build reads`);
        } finally {
          revert();
        }
      }
      assertFresh(target, 'after reverting every script edit');
    });

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
        it(name, () => {
          assertInputClass(target, edit);
        });
      }

      it('SOURCE_DATE_EPOCH', () => {
        assertInputClass(target, null, { env: { SOURCE_DATE_EPOCH: '1700000000' } });
      });

      it('linked dependency in node_modules', () => {
        const result = assertInputClass(target, edits.linkDependencies);
        assert.match(result.reason, /linked dependency/, result.run.describe());
      });
    });

    it(`ensure ${target} on unchanged inputs prints the hit line, spawns no build, writes nothing and leaves the outputs byte-identical`, () => {
      assertFresh(target, 'before the hit');
      const stampBefore = fs.readFileSync(abs(stamp), 'utf8');
      const outputsBefore = snapshotOutputs(target);

      const run = cli(['ensure', target], { trace: true });

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
  it('ensure schemas compliance prints one hit line per target, in order, when both are current', () => {
    const run = cli(['ensure', 'schemas', 'compliance']);
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

    it(`ensure ${target} after one input edit reports a miss, runs the build and stamps the new inputs`, () => {
      assertFresh(target, 'before the edit');
      assert.ok(fs.existsSync(abs(sentinel)), `${sentinel} exists after the first build`);
      const stampBefore = fs.readFileSync(abs(stamp), 'utf8');
      edits.append(rebuildEdits[target]); // kept: the rebuilt tree is the new baseline
      fs.rmSync(abs(sentinel)); // an output only a real build writes back

      const run = cli(['ensure', target]);

      assert.equal(run.code, 0, run.describe());
      assert.equal(run.cacheLines.length, 1, run.describe());
      assert.match(run.cacheLines[0], missLine(target), run.describe());
      assert.ok(fs.existsSync(abs(sentinel)), `the build ran and rewrote ${sentinel}`);
      assert.notEqual(fs.readFileSync(abs(stamp), 'utf8'), stampBefore, 'the stamp records the new inputs');
      assertFresh(target, 'after the rebuild');
    });
  }

  for (const [target, broken] of Object.entries({
    schemas: { rel: 'static/schemas/source/core/zz-build-cache-broken.json', content: '{ "broken": \n' },
    compliance: { rel: 'static/compliance/source/universal/zz-build-cache-broken.yaml', content: 'id: zz_broken\nsteps: [unclosed\n' },
  })) {
    const { lockDir, script } = TARGETS[target];

    it(`a failing ${target} build (broken source) exits with the build's status from ensure and from ${script}, and leaves no ${lockDir}`, () => {
      edits.addFile(broken.rel, broken.content); // kept: last case for this target

      const ensured = cli(['ensure', target]);
      assert.equal(ensured.cacheLines.length, 1, ensured.describe());
      assert.match(ensured.cacheLines[0], missLine(target), ensured.describe());
      assert.notEqual(ensured.code, 0, `ensure fails when the build fails\n${ensured.describe()}`);
      assert.equal(fs.existsSync(abs(lockDir)), false, `ensure leaves no ${lockDir}`);

      const explicit = spawnSync(process.execPath, [abs(script)], {
        cwd: root, env: cleanEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS,
      });
      assert.equal(explicit.status, 1, `node ${script} exits 1 on the broken source\n${(explicit.stderr ?? '').slice(-2000)}`);
      assert.equal(ensured.code, explicit.status, 'ensure exits with the build exit status');
      assert.equal(fs.existsSync(abs(lockDir)), false, `the explicit build leaves no ${lockDir}`);
      assertStale(target, 'after a failed build');
    });
  }
});
