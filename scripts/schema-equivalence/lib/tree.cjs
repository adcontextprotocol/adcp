'use strict';

/**
 * Loads the published schema tree at a git ref or from a directory.
 *
 * The build publishes `static/schemas/source/**` as `dist/schemas/<version>/**`
 * with one transformation: `$id`, `$ref`, and `$schema` URIs become absolute
 * `https://adcontextprotocol.org/schemas/<version>/...` URIs
 * (`transformPublishedSchemaText` in scripts/build-schemas.cjs). That rewrite
 * is the identity on the resolved targets, so the source tree is the published
 * tree up to URI spelling. `verify-build` in the CLI checks this claim against
 * a real build.
 *
 * A ref is read straight from the object database (`git ls-tree` plus one
 * `git cat-file --batch`), so no worktree or checkout is needed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_PREFIX = 'static/schemas/source/';
const DIST_PREFIX = 'dist/schemas/';

function git(repo, args, input) {
  const res = spawnSync('git', args, {
    cwd: repo,
    input,
    maxBuffer: 1 << 30,
    encoding: input === undefined ? 'buffer' : undefined,
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(res.stderr || '').trim()}`);
  }
  return res.stdout;
}

function resolveCommit(repo, ref) {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).toString('utf8').trim();
}

/** Reads many blobs in one `git cat-file --batch` call. Returns Map sha -> Buffer. */
function readBlobs(repo, shas) {
  const out = new Map();
  if (shas.length === 0) return out;
  const buf = git(repo, ['cat-file', '--batch'], `${shas.join('\n')}\n`);
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    const [sha, type, sizeText] = header.split(' ');
    if (type === 'missing' || sizeText === undefined) throw new Error(`git object missing: ${header}`);
    const size = Number(sizeText);
    out.set(sha, buf.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return out;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: invalid JSON: ${err.message}`);
  }
}

/** True for files the build publishes as schema roots (it skips index.json registries). */
function isRootFile(rel) {
  return rel.endsWith('.json') && path.posix.basename(rel) !== 'index.json';
}

function loadFromRef(repo, ref) {
  const commit = resolveCommit(repo, ref);
  const listing = git(repo, ['ls-tree', '-r', '-z', commit, '--', SOURCE_PREFIX]).toString('utf8');
  const entries = [];
  for (const line of listing.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [, type, sha] = line.slice(0, tab).split(' ');
    const file = line.slice(tab + 1);
    if (type !== 'blob' || !file.endsWith('.json')) continue;
    entries.push({ rel: file.slice(SOURCE_PREFIX.length), sha });
  }
  const blobs = readBlobs(repo, [...new Set(entries.map(e => e.sha))]);
  const files = new Map();
  for (const { rel, sha } of entries) {
    files.set(rel, parseJson(blobs.get(sha).toString('utf8'), `${ref}:${SOURCE_PREFIX}${rel}`));
  }
  const distCache = new Map();
  return {
    label: ref,
    commit,
    files,
    /** A file under dist/schemas/ at the same commit (pinned released schemas). */
    readDist(rel) {
      if (distCache.has(rel)) return distCache.get(rel);
      let doc = null;
      const res = spawnSync('git', ['cat-file', '-p', `${commit}:${DIST_PREFIX}${rel}`], { cwd: repo, maxBuffer: 1 << 28 });
      if (res.status === 0) doc = parseJson(res.stdout.toString('utf8'), `${commit}:${DIST_PREFIX}${rel}`);
      distCache.set(rel, doc);
      return doc;
    },
  };
}

function walkDir(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, base, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * A directory that plays the role of static/schemas/source. `distDir`, when
 * given, plays the role of dist/schemas (pinned released schemas).
 */
function loadFromDir(dir, distDir) {
  const files = new Map();
  for (const rel of walkDir(dir).sort()) {
    files.set(rel, parseJson(fs.readFileSync(path.join(dir, rel), 'utf8'), path.join(dir, rel)));
  }
  return {
    label: dir,
    commit: null,
    files,
    readDist(rel) {
      if (!distDir) return null;
      const full = path.join(distDir, rel);
      return fs.existsSync(full) ? parseJson(fs.readFileSync(full, 'utf8'), full) : null;
    },
  };
}

module.exports = { loadFromRef, loadFromDir, resolveCommit, isRootFile, git, readBlobs, SOURCE_PREFIX };
