'use strict';

/**
 * The published schema tree, dist/schemas/latest, for repository tooling and
 * tests.
 *
 * The schema build composes the protocol envelope into closed response roots
 * and branches (scripts/compose-response-envelope.cjs), so a raw source
 * response schema is not the published contract. Every validator of a
 * response reads the built tree, through this module or, in the server, from
 * the dist/schemas/latest the runtime image ships.
 *
 * `ensureBuiltSchemas()` rebuilds the tree when the build inputs changed since
 * the last build. It holds a lock directory while it builds, so concurrent
 * test processes build once and wait for each other.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const BUILT_DIR = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
const BUILT_ORIGIN = 'https://adcontextprotocol.org/schemas/latest/';
const STAMP_PATH = path.join(BUILT_DIR, '.build-inputs.sha256');
const LOCK_DIR = path.join(REPO_ROOT, 'dist', 'schemas', '.latest-build.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;
const BUILD_INPUT_FILES = [
  'package.json',
  'scripts/build-schemas.cjs',
  'scripts/compose-response-envelope.cjs',
  'scripts/mcp-schema-projection.cjs',
];

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

/** A digest of every file the latest build reads. */
function buildInputsDigest() {
  const files = [
    ...BUILD_INPUT_FILES.map((file) => path.join(REPO_ROOT, file)),
    ...walkFiles(SOURCE_DIR),
  ].sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(REPO_ROOT, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Records that dist/schemas/latest was built from the current inputs. */
function writeBuildStamp() {
  fs.writeFileSync(STAMP_PATH, `${buildInputsDigest()}\n`);
}

function isFresh() {
  try {
    return fs.readFileSync(STAMP_PATH, 'utf8').trim() === buildInputsDigest();
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        // Another process released it between the two calls.
      }
      sleep(250);
    }
  }
}

const LOCK_HELD_ENV = 'ADCP_SCHEMA_BUILD_LOCK_HELD';

/**
 * Runs `fn` while holding the build lock, so two builds of
 * dist/schemas/latest never interleave. scripts/build-schemas.cjs takes it
 * too; a build that ensureBuiltSchemas starts inherits the held lock.
 */
async function withBuildLock(fn) {
  if (process.env[LOCK_HELD_ENV] === '1') return fn();
  acquireLock();
  try {
    return await fn();
  } finally {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

/** Builds dist/schemas/latest unless it is current; returns its path. */
function ensureBuiltSchemas() {
  if (isFresh()) return BUILT_DIR;
  acquireLock();
  try {
    if (!isFresh()) {
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build-schemas.cjs')], {
        cwd: REPO_ROOT,
        env: { ...process.env, [LOCK_HELD_ENV]: '1' },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    }
  } finally {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }
  return BUILT_DIR;
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
  builtSchemaFiles,
  builtSchemaPath,
  ensureBuiltSchemas,
  readBuiltSchema,
  withBuildLock,
  writeBuildStamp,
};
