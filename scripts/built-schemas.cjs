'use strict';

/**
 * The published schema tree, dist/schemas/latest, for repository tooling and
 * tests.
 *
 * Every validator of a response reads one tree, the one the build publishes:
 * through this module or, in the server, from the dist/schemas/latest the
 * runtime image ships. Responses compose the protocol envelope through their
 * root `allOf` and their roots are open, so the built tree and source agree;
 * reading the published output keeps one path for every validator.
 *
 * `ensureBuiltSchemas()` rebuilds the tree when the build inputs changed since
 * the last build. It holds a lock directory while it builds, so concurrent
 * test processes build once and wait for each other.
 *
 * The same input-digest cache covers dist/compliance/latest
 * (`ensureBuiltCompliance()`), and the CLI at the end of this file serves
 * shell callers such as scripts/run-storyboards-matrix.sh. A build is skipped
 * only when the stamp in the built tree records the digest of the current
 * inputs and no dependency in node_modules is linked. Running
 * scripts/build-*.cjs directly always builds.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const BUILT_DIR = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
const BUILT_ORIGIN = 'https://adcontextprotocol.org/schemas/latest/';
const LOCK_STALE_MS = 10 * 60 * 1000;
const STAMP_NAME = '.build-inputs.sha256';
// ADCP_BUILD_CACHE=0 makes ensure always build.
const FORCE_ENV = 'ADCP_BUILD_CACHE';

// Inputs every build shares. The lockfiles pin node_modules; a linked
// dependency (npm link, file:) is checked separately because its content is
// not in them. The Node version and SOURCE_DATE_EPOCH change the output.
const COMMON_FILES = ['package.json', 'package-lock.json', 'node_modules/.package-lock.json', 'scripts/built-schemas.cjs'];
// Release directories under dist/schemas. Their names feed the tracked
// discovery files, and the symbol linker checks which release ships a schema.
// Released trees are immutable (scripts/check-immutable-release-artifacts.cjs),
// so the names are the whole input.
const RELEASE_LISTING = { dir: 'dist/schemas', filter: (entry) => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name) };

/**
 * The cached builds and every input each one reads: files, trees (every file
 * below, by path and content) and listings (entry names). The read-set guard
 * in tests/build-cache.test.cjs runs the real builds and fails when one reads
 * something these lists do not cover.
 */
const TARGETS = {
  schemas: {
    script: 'scripts/build-schemas.cjs',
    builtDir: BUILT_DIR,
    lockDir: path.join(REPO_ROOT, 'dist', 'schemas', '.latest-build.lock'),
    lockHeldEnv: 'ADCP_SCHEMA_BUILD_LOCK_HELD',
    files: [...COMMON_FILES, 'scripts/build-schemas.cjs', 'scripts/mcp-schema-projection.cjs'],
    // build-schemas reads the compliance source for manifest.json.
    trees: ['static/schemas/source', 'static/compliance/source'],
    listings: [RELEASE_LISTING],
  },
  compliance: {
    script: 'scripts/build-compliance.cjs',
    builtDir: path.join(REPO_ROOT, 'dist', 'compliance', 'latest'),
    lockDir: path.join(REPO_ROOT, 'dist', 'compliance', '.latest-build.lock'),
    lockHeldEnv: 'ADCP_COMPLIANCE_BUILD_LOCK_HELD',
    files: COMMON_FILES,
    // The build runs some 25 scripts (lints, snippets, symbol links) and their
    // helpers; the whole scripts tree is the safe superset. It reads and
    // rewrites docs.
    trees: ['scripts', 'static/compliance/source', 'static/schemas/source', { dir: 'docs', filter: (name) => /\.mdx?$/.test(name) }],
    listings: [RELEASE_LISTING],
  },
};

function targetOf(name) {
  const target = TARGETS[name];
  if (!target) throw new Error(`unknown build target ${name}; expected ${Object.keys(TARGETS).join(' or ')}`);
  return target;
}

function walkFiles(directory, accept = () => true) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(full, accept);
    return accept(entry.name) ? [full] : [];
  });
}

/** A digest of every input the target's build reads (default: schemas). */
function buildInputsDigest(name = 'schemas') {
  const target = targetOf(name);
  const files = [
    ...target.files.map((file) => path.join(REPO_ROOT, file)),
    ...target.trees.flatMap((tree) => (typeof tree === 'string'
      ? walkFiles(path.join(REPO_ROOT, tree))
      : walkFiles(path.join(REPO_ROOT, tree.dir), tree.filter))),
  ].sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(REPO_ROOT, file));
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('<absent>');
    }
    hash.update('\0');
  }
  for (const listing of target.listings) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(REPO_ROOT, listing.dir), { withFileTypes: true }).filter(listing.filter).map((entry) => entry.name).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    hash.update(`listing:${listing.dir}\0${names.join('\0')}\0`);
  }
  hash.update(`node:${process.version}\0`);
  hash.update(`SOURCE_DATE_EPOCH:${process.env.SOURCE_DATE_EPOCH ?? ''}\0`);
  return hash.digest('hex');
}

/** The first top-level node_modules package that is a symlink, if any. */
function linkedDependency() {
  const root = path.join(REPO_ROOT, 'node_modules');
  const scan = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) return `${prefix}${entry.name}`;
      if (!prefix && entry.name.startsWith('@') && entry.isDirectory()) {
        const found = scan(path.join(dir, entry.name), `${entry.name}/`);
        if (found) return found;
      }
    }
    return null;
  };
  return scan(root, '');
}

function stampPath(name) {
  return path.join(targetOf(name).builtDir, STAMP_NAME);
}

// The digest taken when this process's build started, per target. The stamp
// records it, so an input edited while the build runs is not marked current.
const startDigests = new Map();

/** Records that the target's tree was built from its inputs (default: schemas). */
function writeBuildStamp(name = 'schemas') {
  fs.writeFileSync(stampPath(name), `${startDigests.get(name) ?? buildInputsDigest(name)}\n`);
}

/** Whether the target's built tree is current: { fresh, reason, digest }. */
function buildStatus(name = 'schemas') {
  if (process.env[FORCE_ENV] === '0') return { fresh: false, reason: `${FORCE_ENV}=0` };
  const linked = linkedDependency();
  if (linked) return { fresh: false, reason: `linked dependency ${linked}` };
  const digest = buildInputsDigest(name);
  let stamped = null;
  try {
    stamped = fs.readFileSync(stampPath(name), 'utf8').trim();
  } catch {
    return { fresh: false, reason: `no stamp in ${path.relative(REPO_ROOT, targetOf(name).builtDir)}`, digest };
  }
  if (stamped !== digest) return { fresh: false, reason: 'inputs changed', digest };
  return { fresh: true, reason: 'current', digest };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Lock directories this process holds. They are removed on exit too, so a
// build that ends in process.exit() does not leave its lock behind.
const heldLocks = new Set();
process.on('exit', () => {
  for (const dir of heldLocks) fs.rmSync(dir, { recursive: true, force: true });
});

function acquireLock(lockDir) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      heldLocks.add(lockDir);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Another process released it between the two calls.
      }
      sleep(250);
    }
  }
}

function releaseLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
  heldLocks.delete(lockDir);
}

/**
 * Runs `fn`, a target's build, while holding that target's lock, so two
 * builds never interleave; scripts/build-*.cjs take it. A build that ensure
 * starts inherits the held lock. The input digest is taken here, at the
 * start, for writeBuildStamp.
 */
async function withBuildLock(fn, name = 'schemas') {
  const target = targetOf(name);
  const held = process.env[target.lockHeldEnv] === '1';
  if (!held) acquireLock(target.lockDir);
  try {
    startDigests.set(name, buildInputsDigest(name));
    return await fn();
  } finally {
    if (!held) releaseLock(target.lockDir);
  }
}

/**
 * Builds the target unless it is current. Prints one stderr line saying
 * which, and returns the build's exit status (0 when skipped).
 */
function ensureBuilt(name, { quiet = false } = {}) {
  const target = targetOf(name);
  const say = (line) => { if (!quiet) process.stderr.write(`build-cache: ${line}\n`); };
  let status = buildStatus(name);
  if (status.fresh) {
    say(`${path.relative(REPO_ROOT, target.builtDir)} current (inputs ${status.digest.slice(0, 12)}); skipped ${target.script}`);
    return 0;
  }
  acquireLock(target.lockDir);
  try {
    // Another process may have built it while this one waited for the lock.
    status = buildStatus(name);
    if (status.fresh) {
      say(`${path.relative(REPO_ROOT, target.builtDir)} current (inputs ${status.digest.slice(0, 12)}); skipped ${target.script}`);
      return 0;
    }
    say(`${status.reason}; running ${target.script}`);
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, target.script)], {
      cwd: REPO_ROOT,
      env: { ...process.env, [target.lockHeldEnv]: '1' },
      stdio: quiet ? ['ignore', 'ignore', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    releaseLock(target.lockDir);
  }
}

/** Builds dist/schemas/latest unless it is current; returns its path. */
function ensureBuiltSchemas() {
  const status = ensureBuilt('schemas', { quiet: true });
  if (status !== 0) throw new Error(`scripts/build-schemas.cjs exited ${status}`);
  return BUILT_DIR;
}

/** Builds dist/compliance/latest unless it is current; returns its path. */
function ensureBuiltCompliance() {
  const status = ensureBuilt('compliance', { quiet: true });
  if (status !== 0) throw new Error(`scripts/build-compliance.cjs exited ${status}`);
  return TARGETS.compliance.builtDir;
}

/** The built path for a schema named by source path, `/schemas/` URI or relative path. */
function builtSchemaPath(location) {
  let relative = location;
  if (relative.startsWith(BUILT_ORIGIN)) relative = relative.slice(BUILT_ORIGIN.length);
  else if (relative.startsWith('/schemas/')) relative = relative.slice('/schemas/'.length);
  else if (path.isAbsolute(relative)) {
    const from = [SOURCE_DIR, BUILT_DIR].find((root) => relative.startsWith(`${root}${path.sep}`));
    if (!from) throw new Error(`not a schema path: ${location}`);
    relative = path.relative(from, relative);
  }
  return path.join(BUILT_DIR, relative.split('#')[0]);
}

function toSourceUris(value) {
  if (typeof value === 'string') {
    return value.startsWith(BUILT_ORIGIN) ? `/schemas/${value.slice(BUILT_ORIGIN.length)}` : value;
  }
  if (Array.isArray(value)) return value.map(toSourceUris);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toSourceUris(entry)]));
}

/**
 * A built schema with its `$id` and `$ref`s in the `/schemas/...` form the
 * source tree uses, so loaders keyed on that form resolve it. The content is
 * the build's output; only the URI base changes.
 */
function readBuiltSchema(location) {
  return toSourceUris(JSON.parse(fs.readFileSync(builtSchemaPath(location), 'utf8')));
}

/**
 * Every built schema file, excluding the bundled and MCP projections and the
 * core/async-response-refs copies, which reuse the $ids of what they project.
 */
function builtSchemaFiles() {
  const skip = new Set(['bundled', 'mcp', 'core/async-response-refs'].map((directory) => path.join(BUILT_DIR, directory)));
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return skip.has(full) ? [] : walk(full);
      return entry.name.endsWith('.json') ? [full] : [];
    });
  }
  return walk(BUILT_DIR);
}

module.exports = {
  BUILT_DIR,
  BUILT_ORIGIN,
  buildInputsDigest,
  buildStatus,
  builtSchemaFiles,
  builtSchemaPath,
  ensureBuilt,
  ensureBuiltCompliance,
  ensureBuiltSchemas,
  readBuiltSchema,
  withBuildLock,
  writeBuildStamp,
};

// CLI for shell callers:
//   node scripts/built-schemas.cjs ensure <schemas|compliance>...  build unless current; exits with the first failing build's status
//   node scripts/built-schemas.cjs status <schemas|compliance>     prints "fresh" or "stale <reason>"; exits 0
if (require.main === module) {
  const [command, ...names] = process.argv.slice(2);
  const usage = 'usage: node scripts/built-schemas.cjs ensure <schemas|compliance>... | status <schemas|compliance>';
  if (!names.length || !names.every((name) => name in TARGETS) || !['ensure', 'status'].includes(command)) {
    console.error(usage);
    process.exit(2);
  }
  if (command === 'status') {
    for (const name of names) {
      const status = buildStatus(name);
      process.stdout.write(status.fresh ? 'fresh\n' : `stale ${status.reason}\n`);
    }
  } else {
    for (const name of names) {
      const code = ensureBuilt(name);
      if (code !== 0) process.exit(code);
    }
  }
}
