#!/usr/bin/env node
/**
 * Additive-minor guard for AdCP schemas: a minor release only adds.
 *
 * A buyer or seller that validates against the published schemas of its
 * release must keep accepting what a later release in the same major line
 * sends. This script compares two schema trees, a base and a candidate, and
 * reports the changes listed under Violations.
 *
 * Trees
 *   - A released tree is dist/schemas/<version>/ without the derived
 *     artifacts (bundled/, mcp/, manifest.json). It is read from disk when
 *     present and from git (HEAD) otherwise, so a sparse checkout works.
 *   - The source tree is static/schemas/source/.
 *   - Files are matched by `$id` (host and version segment stripped), falling
 *     back to the path. Inside a file, schemas are matched by JSON pointer.
 *     `$ref`s that name the same file on both sides are not followed (that
 *     file is compared on its own); `$ref`s that differ are resolved and the
 *     targets compared in place.
 *   - A base schema marked `x-status: "experimental"`, or in a file whose
 *     root is, is not compared: docs/reference/versioning.mdx classes
 *     experimental-only changes as patch-level.
 *
 * Default base (CI and `--candidate` without `--base`)
 *   The highest released stable version in the candidate's major line that
 *   does not exceed the candidate version. A 3.3 prerelease is therefore
 *   checked against the latest 3.2.x, because 3.3.0 must be additive over
 *   it. A major line with no stable release yet has no base, and the check
 *   passes with a notice: a major release may break.
 *
 * Violations (fail CI unless recorded in the baseline)
 *   property-added-to-closed, property-removed, required-added,
 *   type-narrowed, enum-value-removed, const-changed, bound-tightened,
 *   additional-properties-closed, file-removed.
 *
 * Closed schemas (DR-0036)
 *   A schema that any stable release of the major published closed
 *   (`additionalProperties: false` or `unevaluatedProperties: false`) stays
 *   closed until the next major, even after a later release opens it. CI
 *   compares every earlier stable release of the base's major with the base,
 *   using the same node and branch matching, and records each node that an
 *   earlier release closed and the base leaves open. A property that such a
 *   node lacked in the last release that closed it is reported as
 *   property-added-to-closed, with that release named in the detail. A
 *   finding whose property the base already has is marked released: it
 *   shipped in a stable release and may enter the baseline at any time.
 *
 * Notices (never fail)
 *   additional-properties-opened: a closed schema is opened. Opening breaks no
 *   validator, but it permits no additions within the major.
 *
 * Reopened schemas
 *   scripts/lint-additive-minor-reopened.json lists the schemas DR-0036
 *   reopens as a one-time correction, each with the release from which
 *   additions are allowed. Every other closed schema stays closed.
 *
 * Modes
 *   (default)                    CI: candidate = source, base = default base;
 *                                fails on any violation not in the baseline.
 *   --base <v> --candidate <v|source>
 *                                prints a report; exits 0.
 *   --history                    runs the check across consecutive 3.x
 *                                releases and prints tables and findings.
 *                                Each pair is compared on its own, without
 *                                the earlier-release closures.
 *   --prune-baseline             removes stale baseline entries only.
 *   --baseline-ref <git-ref>     also fails when the baseline has an entry
 *                                that the baseline at <git-ref> lacks, so the
 *                                baseline only shrinks. Defaults to
 *                                $ADCP_ADDITIVE_MINOR_BASELINE_REF.
 *
 * Background: DR-0009 makes schemas open by default so that a minor can add
 * optional fields, but many published schemas close objects with
 * `additionalProperties: false`. A later minor that adds a field to a closed
 * object breaks a receiver that validates against the earlier release.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const DIST_SCHEMAS = 'dist/schemas';
const DEFAULT_BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'lint-additive-minor-baseline.json');
const BASELINE_REPO_PATH = 'scripts/lint-additive-minor-baseline.json';
const DEFAULT_REOPENED_PATH = path.join(REPO_ROOT, 'scripts', 'lint-additive-minor-reopened.json');
const BASELINE_REF_ENV = 'ADCP_ADDITIVE_MINOR_BASELINE_REF';

// Derived artifacts in a released tree that have no source counterpart: the
// bundled and MCP projections, the tool manifest, and the build's copies of
// async response schemas.
const DERIVED_PREFIXES = ['bundled/', 'mcp/', 'manifest.json', 'core/async-response-refs/'];

const VIOLATION_KINDS = [
  'property-added-to-closed',
  'property-removed',
  'required-added',
  'type-narrowed',
  'enum-value-removed',
  'const-changed',
  'bound-tightened',
  'additional-properties-closed',
  'file-removed',
];
const VIOLATIONS = new Set(VIOLATION_KINDS);
const NOTICE_KINDS = ['additional-properties-opened'];

// Lower bounds tighten upward; upper bounds tighten downward.
const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];
// Keys that carry no validation meaning.
const ANNOTATION_KEYS = new Set([
  '$id', '$schema', '$comment', 'title', 'description', 'examples', 'example',
  'default', 'deprecated', 'readOnly', 'writeOnly',
]);

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(value) {
  const match = SEMVER.exec(String(value));
  if (!match) return null;
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isStable(version) {
  return parseVersion(version).prerelease.length === 0;
}

/**
 * The default base for a candidate: the highest stable release in the same
 * major line that does not exceed the candidate. Returns null when the major
 * line has no stable release yet.
 */
function defaultBaseVersion(candidateVersion, releasedVersions) {
  const candidate = parseVersion(candidateVersion);
  if (!candidate) throw new Error(`not a semantic version: ${candidateVersion}`);
  const eligible = releasedVersions
    .map(parseVersion)
    .filter(Boolean)
    .filter((v) => v.major === candidate.major && v.prerelease.length === 0)
    .filter((v) => compareVersions(v, candidate) <= 0 && v.raw !== candidate.raw)
    .sort(compareVersions);
  return eligible.length ? eligible[eligible.length - 1].raw : null;
}

/**
 * Consecutive comparisons for `--history`. The chain runs through the first
 * stable release of every minor, the latest patch of the newest stable minor,
 * the newest prerelease above it, and the source. Patch lines (first to last
 * patch of each earlier minor) are listed separately because their late
 * patches postdate the next minor's first release.
 */
function historyPairs(releasedVersions, major, { includeSource = true } = {}) {
  const versions = releasedVersions
    .map(parseVersion)
    .filter((v) => v && v.major === major)
    .sort(compareVersions);
  const stable = versions.filter((v) => v.prerelease.length === 0);
  const byMinor = new Map();
  for (const v of stable) {
    if (!byMinor.has(v.minor)) byMinor.set(v.minor, []);
    byMinor.get(v.minor).push(v.raw);
  }
  const minors = [...byMinor.keys()].sort((a, b) => a - b);
  const chain = minors.map((minor) => byMinor.get(minor)[0]);
  const patchLines = [];
  minors.forEach((minor, index) => {
    const line = byMinor.get(minor);
    if (line.length < 2) return;
    const pair = { base: line[0], candidate: line[line.length - 1], patchLine: true };
    if (index === minors.length - 1) chain.push(pair.candidate);
    else patchLines.push(pair);
  });
  const lastStable = stable.length ? stable[stable.length - 1] : null;
  const prereleases = versions.filter(
    (v) => v.prerelease.length > 0 && (!lastStable || compareVersions(v, lastStable) > 0),
  );
  if (prereleases.length) chain.push(prereleases[prereleases.length - 1].raw);
  if (includeSource) chain.push('source');
  const pairs = [];
  for (let i = 1; i < chain.length; i += 1) {
    const base = chain[i - 1];
    const candidate = chain[i];
    const sameMinor = candidate !== 'source'
      && parseVersion(base).minor === parseVersion(candidate).minor
      && isStable(candidate);
    pairs.push({ base, candidate, patchLine: sameMinor });
  }
  return { pairs, patchLines };
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    input: options.input,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function walkJsonFiles(directory, root = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = toPosix(path.relative(root, full));
    if (entry.isDirectory()) {
      if (!isDerived(`${relative}/`)) files.push(...walkJsonFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith('.json') && !isDerived(relative)) files.push(relative);
  }
  return files.sort();
}

function isDerived(relativePath) {
  return DERIVED_PREFIXES.some((prefix) => (prefix.endsWith('/') ? relativePath.startsWith(prefix) : relativePath === prefix));
}

/** Lists released schema versions from disk and from git HEAD. */
function listReleasedVersions(repoRoot = REPO_ROOT) {
  const found = new Set();
  const distDir = path.join(repoRoot, DIST_SCHEMAS);
  if (fs.existsSync(distDir)) {
    for (const name of fs.readdirSync(distDir)) if (parseVersion(name)) found.add(name);
  }
  try {
    const listing = git(['ls-tree', '--name-only', 'HEAD', `${DIST_SCHEMAS}/`], { cwd: repoRoot });
    for (const line of listing.split('\n')) {
      const name = line.split('/').pop();
      if (parseVersion(name)) found.add(name);
    }
  } catch {
    // Not a git checkout; the disk listing stands.
  }
  return [...found].sort(compareVersions);
}

function readGitFiles(repoRoot, ref, prefix) {
  const listing = git(['ls-tree', '-r', '-z', ref, '--', `${prefix}/`], { cwd: repoRoot });
  const entries = listing
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      return { oid: meta.split(' ')[2], file };
    })
    .filter(({ file }) => file.endsWith('.json'));
  if (!entries.length) return new Map();
  const output = git(['cat-file', '--batch'], {
    cwd: repoRoot,
    encoding: null,
    input: `${entries.map(({ oid }) => oid).join('\n')}\n`,
  });
  const files = new Map();
  let offset = 0;
  for (const { file } of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    const size = Number(output.toString('utf8', offset, headerEnd).split(' ')[2]);
    const start = headerEnd + 1;
    files.set(file.slice(prefix.length + 1), output.toString('utf8', start, start + size));
    offset = start + size + 1;
  }
  return files;
}

const ADCP_HOSTS = new Set(['adcontextprotocol.org', 'www.adcontextprotocol.org']);
const VERSION_SEGMENT = /^\/schemas\/(?:latest|v?\d+(?:\.\d+)*(?:-[\w.]+)?)\//;
const RELEASE_SEGMENT = /\/schemas\/(?:latest|v?\d+(?:\.\d+)*(?:-[\w.]+)?)\//g;

/**
 * Maps a `$id` or the file part of a `$ref` to a tree-relative path. Returns
 * null for locations outside the AdCP schema tree.
 */
function normalizeSchemaPath(value, fromKey = null) {
  if (!value) return fromKey;
  let normalized = value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(parsed.protocol) || !ADCP_HOSTS.has(parsed.hostname)) return null;
    normalized = parsed.pathname;
  }
  if (normalized.startsWith('/')) {
    if (!normalized.startsWith('/schemas/')) return null;
    return normalized.replace(VERSION_SEGMENT, '/schemas/').replace(/^\/schemas\//, '');
  }
  const dir = fromKey ? path.posix.dirname(fromKey) : '.';
  return path.posix.normalize(path.posix.join(dir, normalized));
}

// Parsed schemas by their text without release segments. Released trees
// share most files, and every comparison normalizes release segments, so
// trees may share one parsed copy. Parsed schemas are never mutated.
const parsedByText = new Map();

/**
 * Builds a tree from `{ relativePath: text }`. Each document is keyed by its
 * normalized `$id` when it has one inside the AdCP tree, else by its path.
 */
function buildTree(label, rawFiles) {
  const documents = new Map();
  const errors = [];
  for (const [relativePath, text] of rawFiles) {
    if (isDerived(relativePath)) continue;
    // The text without release segments, so identical files in two releases compare equal.
    const unversioned = typeof text === 'string' ? text.replace(RELEASE_SEGMENT, '/schemas/') : null;
    let schema = unversioned === null ? text : parsedByText.get(unversioned);
    if (schema === undefined) {
      try {
        schema = JSON.parse(text);
      } catch (error) {
        errors.push(`${label}/${relativePath}: ${error.message}`);
        continue;
      }
      parsedByText.set(unversioned, schema);
    }
    const idKey = schema && typeof schema.$id === 'string' ? normalizeSchemaPath(schema.$id) : null;
    const key = idKey || relativePath;
    if (documents.has(key)) errors.push(`${label}: ${relativePath} and ${documents.get(key).path} share ${key}`);
    else documents.set(key, { key, path: relativePath, schema, unversioned });
  }
  const locations = new WeakMap();
  for (const { key, schema } of documents.values()) recordLocations(schema, key, '', locations);
  return { label, documents, errors, locations };
}

/**
 * Records each object node's own location, `<document key>#<pointer>`, so a
 * node keeps its identity however the comparison reached it.
 */
function recordLocations(node, docKey, pointer, locations) {
  if (node === null || typeof node !== 'object') return;
  if (!Array.isArray(node)) locations.set(node, `${docKey}#${pointer}`);
  for (const [key, value] of Object.entries(node)) recordLocations(value, docKey, child(pointer, key), locations);
}

/** The own location of a node of `tree`, or null. */
function locate(tree, node) {
  return tree && tree.locations && isObject(node) ? tree.locations.get(node) || null : null;
}

/** Gives `copy`, derived from `node`, the location of `node`. */
function inheritLocation(tree, copy, node) {
  const location = locate(tree, node);
  if (location && isObject(copy)) tree.locations.set(copy, location);
  return copy;
}

function loadDirectoryTree(directory, label = toPosix(path.relative(REPO_ROOT, directory)) || directory) {
  const raw = new Map();
  for (const file of walkJsonFiles(directory)) raw.set(file, fs.readFileSync(path.join(directory, file), 'utf8'));
  return buildTree(label, raw);
}

/** Loads dist/schemas/<version> from disk, or from git HEAD when not checked out. */
function loadReleasedTree(version, repoRoot = REPO_ROOT) {
  const prefix = `${DIST_SCHEMAS}/${version}`;
  const directory = path.join(repoRoot, prefix);
  if (fs.existsSync(directory)) return loadDirectoryTree(directory, version);
  const files = readGitFiles(repoRoot, 'HEAD', prefix);
  if (!files.size) throw new Error(`no released schema tree for ${version} (looked in ${prefix} and git HEAD)`);
  return buildTree(version, files);
}

function readSourceVersion(repoRoot = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

function loadTreeSpec(spec, { repoRoot = REPO_ROOT, sourceDir = DEFAULT_SOURCE_DIR } = {}) {
  if (spec === 'source') return loadDirectoryTree(sourceDir, 'source');
  if (parseVersion(spec)) return loadReleasedTree(spec, repoRoot);
  if (fs.existsSync(spec) && fs.statSync(spec).isDirectory()) return loadDirectoryTree(path.resolve(spec));
  throw new Error(`unknown tree: ${spec} (expected a released version, "source", or a directory)`);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function child(pointer, ...segments) {
  return `${pointer}/${segments.map(escapePointer).join('/')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON of a schema with annotations dropped and refs normalized. */
function canonicalSchema(node, docKey) {
  if (Array.isArray(node)) return node.map((item) => canonicalSchema(item, docKey));
  if (!isObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATION_KEYS.has(key) || key.startsWith('x-')) continue;
    if (key === '$ref' && typeof value === 'string') out.$ref = normalizeRef(value, docKey) || value;
    else if (key === 'enum' || key === 'const') out[key] = value;
    else out[key] = canonicalSchema(value, docKey);
  }
  return out;
}

function normalizeRef(ref, docKey) {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);
  const key = normalizeSchemaPath(filePart, docKey);
  return key ? `${key}#${fragment}` : null;
}

function readPointer(root, fragment) {
  if (!fragment) return root;
  if (!fragment.startsWith('/')) return undefined;
  let current = root;
  for (const raw of fragment.slice(1).split('/')) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Follows `$ref` chains from a node. Sibling keywords of a `$ref` are kept
 * and override the target's. Returns null when a ref does not resolve.
 */
function resolveNode(node, docKey, tree) {
  let current = node;
  let currentDoc = docKey;
  const seen = new Set();
  while (isObject(current) && typeof current.$ref === 'string') {
    const target = normalizeRef(current.$ref, currentDoc);
    if (!target || seen.has(target)) return null;
    seen.add(target);
    const [key, fragment] = target.split('#');
    const document = tree.documents.get(key);
    const resolved = document ? readPointer(document.schema, fragment) : undefined;
    if (resolved === undefined) return null;
    const { $ref, ...siblings } = current;
    current = isObject(resolved) ? inheritLocation(tree, { ...resolved, ...siblings }, resolved) : resolved;
    currentDoc = key;
  }
  return { node: current, docKey: currentDoc };
}

function typeSet(node) {
  if (node.type === undefined) return null;
  return new Set(Array.isArray(node.type) ? node.type : [node.type]);
}

function valueSet(node) {
  if (node.const !== undefined) return [node.const];
  if (Array.isArray(node.enum)) return node.enum;
  return null;
}

function isClosed(node) {
  return node.additionalProperties === false || node.unevaluatedProperties === false;
}

function isExperimental(node) {
  return isObject(node) && node['x-status'] === 'experimental';
}

/** True when a composition branch of `node` declares property `name`. */
function compositionDeclares(node, docKey, tree, name) {
  for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
    for (const branch of Array.isArray(node[keyword]) ? node[keyword] : []) {
      const resolved = resolveNode(branch, docKey, tree);
      if (resolved && isObject(resolved.node) && isObject(resolved.node.properties)
        && Object.prototype.hasOwnProperty.call(resolved.node.properties, name)) return true;
    }
  }
  return false;
}

function namesIn(node, keyword) {
  if (keyword === 'required') return Array.isArray(node.required) ? node.required : [];
  return isObject(node.properties) ? Object.keys(node.properties) : [];
}

/**
 * Property names that a node and its `allOf` entries, one level deep, list
 * under `keyword` (`properties` or `required`).
 */
function declaredNames(node, docKey, tree, keyword) {
  const names = new Set(namesIn(node, keyword));
  for (const entry of Array.isArray(node.allOf) ? node.allOf : []) {
    const resolved = resolveNode(entry, docKey, tree);
    if (resolved && isObject(resolved.node)) namesIn(resolved.node, keyword).forEach((name) => names.add(name));
  }
  return names;
}

const BRANCH_KEY_TYPES = ['ref', 'disc', 'title', 'req', 'if'];

/**
 * Keys that identify a composition branch independent of its position:
 * its `$ref` target, its const-valued (discriminator) properties, its title,
 * its required set, and its `if` condition.
 */
function branchKeys(branch, docKey) {
  const keys = {};
  if (!isObject(branch)) return keys;
  if (typeof branch.$ref === 'string') keys.ref = normalizeRef(branch.$ref, docKey) || branch.$ref;
  if (typeof branch.title === 'string') keys.title = branch.title;
  if (isObject(branch.properties)) {
    const consts = Object.keys(branch.properties).sort().flatMap((name) => {
      const prop = branch.properties[name];
      if (!isObject(prop)) return [];
      if (prop.const !== undefined) return [`${name}=${stableStringify(prop.const)}`];
      if (Array.isArray(prop.enum) && prop.enum.length === 1) return [`${name}=${stableStringify(prop.enum[0])}`];
      return [];
    });
    if (consts.length) keys.disc = consts.join(',');
  }
  if (Array.isArray(branch.required) && branch.required.length) keys.req = [...branch.required].sort().join(',');
  if (branch.if !== undefined) keys.if = stableStringify(canonicalSchema(branch.if, docKey));
  return keys;
}

/**
 * Pairs base and candidate branches: identical branches first, then by key,
 * then the rest in order when the candidate has at least as many left.
 * Unpaired branches are not compared.
 */
function matchBranches(baseBranches, baseDoc, candBranches, candDoc) {
  const baseKeys = baseBranches.map((node) => branchKeys(node, baseDoc));
  const candKeys = candBranches.map((node) => branchKeys(node, candDoc));
  const pairs = [];
  const usedBase = new Set();
  const usedCand = new Set();
  const pair = (i, j) => {
    pairs.push([i, j]);
    usedBase.add(i);
    usedCand.add(j);
  };
  const candCanonical = candBranches.map((node) => stableStringify(canonicalSchema(node, candDoc)));
  baseBranches.forEach((node, i) => {
    const text = stableStringify(canonicalSchema(node, baseDoc));
    const j = candCanonical.findIndex((value, index) => value === text && !usedCand.has(index));
    if (j !== -1) pair(i, j);
  });
  const counts = (keys, used, type) => {
    const map = new Map();
    keys.forEach((k, i) => {
      if (!used.has(i) && k[type] !== undefined) map.set(k[type], (map.get(k[type]) || 0) + 1);
    });
    return map;
  };
  for (const type of BRANCH_KEY_TYPES) {
    const baseCounts = counts(baseKeys, usedBase, type);
    const candCounts = counts(candKeys, usedCand, type);
    baseKeys.forEach((keys, i) => {
      const value = keys[type];
      if (usedBase.has(i) || value === undefined) return;
      if (baseCounts.get(value) !== 1 || candCounts.get(value) !== 1) return;
      pair(i, candKeys.findIndex((k, index) => k[type] === value && !usedCand.has(index)));
    });
  }
  const restBase = baseBranches.map((_, i) => i).filter((i) => !usedBase.has(i));
  const restCand = candBranches.map((_, j) => j).filter((j) => !usedCand.has(j));
  if (restCand.length >= restBase.length) restBase.forEach((i, n) => pair(i, restCand[n]));
  return pairs.sort((x, y) => x[0] - y[0]);
}

function describeValue(value) {
  return stableStringify(value);
}

function describeTypes(set) {
  return [...set].sort().join('|');
}

/**
 * Compares two schema trees. Returns violations as `findings` and
 * `notices`, each `{ file, pointer, kind, detail }`; a finding on a property
 * the base already has also carries `released: true`.
 *
 * Options:
 *   closedEarlier  Map from a base node's location to `{ release, names }`:
 *                  the last earlier stable release that published the node
 *                  closed, and the properties it had there.
 *   reopened       Set of base node locations whose additions are allowed.
 *   onObject       Called as (baseNode, baseLocation, candNode, candLocation)
 *                  for every pair of matched object schemas.
 */
function compareTrees(baseTree, candTree, {
  closedEarlier = null,
  reopened = null,
  onObject = null,
  skipIdentical = false,
} = {}) {
  const findings = [];
  const notices = [];
  const seen = new Set();

  function report(file, pointer, kind, detail, extra = null) {
    const key = `${file}\u0000${pointer}\u0000${kind}\u0000${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    (VIOLATIONS.has(kind) ? findings : notices).push({ file, pointer, kind, detail, ...extra });
  }

  const experimentalFile = (docKey) => {
    const document = baseTree.documents.get(docKey);
    return Boolean(document) && isExperimental(document.schema);
  };

  function compareNode(file, pointer, b, bDoc, c, cDoc, stack, scope = null) {
    if (b === undefined || c === undefined) return;
    if (b === false || c === true) return; // nothing to narrow
    if (isExperimental(b) || experimentalFile(bDoc)) return;
    if (c === false) {
      report(file, pointer, 'type-narrowed', 'schema replaced by false');
      return;
    }
    if (b === true) b = {};
    if (!isObject(b) || !isObject(c)) return;

    // References: identical targets are compared at the target file itself.
    const bRef = typeof b.$ref === 'string' ? normalizeRef(b.$ref, bDoc) : null;
    const cRef = typeof c.$ref === 'string' ? normalizeRef(c.$ref, cDoc) : null;
    if (b.$ref !== undefined || c.$ref !== undefined) {
      if (bRef && cRef && bRef === cRef) {
        const { $ref: _b, ...bRest } = b;
        const { $ref: _c, ...cRest } = c;
        inheritLocation(baseTree, bRest, b);
        inheritLocation(candTree, cRest, c);
        compareNode(file, pointer, bRest, bDoc, cRest, cDoc, stack, scope);
        return;
      }
      const bResolved = b.$ref !== undefined ? resolveNode(b, bDoc, baseTree) : { node: b, docKey: bDoc };
      const cResolved = c.$ref !== undefined ? resolveNode(c, cDoc, candTree) : { node: c, docKey: cDoc };
      if (!bResolved || !cResolved) return;
      const pairKey = `${bRef || `${bDoc}@${pointer}`}|${cRef || `${cDoc}@${pointer}`}`;
      if (stack.has(pairKey)) return;
      const next = new Set(stack).add(pairKey);
      compareNode(file, pointer, bResolved.node, bResolved.docKey, cResolved.node, cResolved.docKey, next, scope);
      return;
    }

    compareType(file, pointer, b, c);
    compareValues(file, pointer, b, c);
    compareBounds(file, pointer, b, c);
    compareObject(file, pointer, b, bDoc, c, cDoc, stack, scope);
    compareCompositions(file, pointer, b, bDoc, c, cDoc, stack, scope);
    if (isObject(b.items) && isObject(c.items)) {
      compareNode(file, child(pointer, 'items'), b.items, bDoc, c.items, cDoc, stack);
    }
    for (const keyword of ['definitions', '$defs']) {
      if (!isObject(b[keyword]) || !isObject(c[keyword])) continue;
      for (const name of Object.keys(b[keyword])) {
        compareNode(file, child(pointer, keyword, name), b[keyword][name], bDoc, c[keyword][name], cDoc, stack);
      }
    }
  }

  function compareType(file, pointer, b, c) {
    const tb = typeSet(b);
    const tc = typeSet(c);
    if (!tb || !tc) return;
    const lost = [...tb].filter((t) => !tc.has(t) && !(t === 'integer' && tc.has('number')));
    if (lost.length) report(file, pointer, 'type-narrowed', `type ${describeTypes(tb)} → ${describeTypes(tc)}`);
  }

  function compareValues(file, pointer, b, c) {
    const vb = valueSet(b);
    const vc = valueSet(c);
    if (!vb || !vc) return;
    const candidate = new Set(vc.map(stableStringify));
    const removed = vb.filter((value) => !candidate.has(stableStringify(value)));
    if (!removed.length) return;
    if (b.const !== undefined && c.const !== undefined) {
      report(file, pointer, 'const-changed', `const ${describeValue(b.const)} → ${describeValue(c.const)}`);
      return;
    }
    for (const value of removed) report(file, pointer, 'enum-value-removed', `value ${describeValue(value)} removed`);
  }

  function compareBounds(file, pointer, b, c) {
    const check = (keyword, tighter) => {
      if (typeof c[keyword] !== 'number') return;
      if (typeof b[keyword] !== 'number') report(file, pointer, 'bound-tightened', `${keyword} ${c[keyword]} added`);
      else if (tighter(c[keyword], b[keyword])) report(file, pointer, 'bound-tightened', `${keyword} ${b[keyword]} → ${c[keyword]}`);
    };
    LOWER_BOUNDS.forEach((keyword) => check(keyword, (next, prev) => next > prev));
    UPPER_BOUNDS.forEach((keyword) => check(keyword, (next, prev) => next < prev));
  }

  function compareObject(file, pointer, b, bDoc, c, cDoc, stack, scope) {
    const bLocation = locate(baseTree, b);
    if (onObject) onObject(b, bLocation, c, locate(candTree, c));
    const describe = (value, doc) => (value === undefined ? 'absent' : stableStringify(canonicalSchema(value, doc)));
    for (const keyword of ['additionalProperties', 'unevaluatedProperties']) {
      const ab = b[keyword];
      const ac = c[keyword];
      if (ac === false && ab !== false) {
        report(file, pointer, 'additional-properties-closed', `${keyword} ${describe(ab, bDoc)} → false`);
      } else if (ab === false && ac !== false) {
        report(file, pointer, 'additional-properties-opened', `${keyword} false → ${describe(ac, cDoc)}`,
          reopened && bLocation && reopened.has(bLocation) ? { reopened: true } : null);
      } else if (isObject(ab) && isObject(ac)) {
        compareNode(file, child(pointer, keyword), ab, bDoc, ac, cDoc, stack);
      }
    }

    const pb = isObject(b.properties) ? b.properties : {};
    const pc = isObject(c.properties) ? c.properties : {};
    for (const name of Object.keys(pb)) {
      if (Object.prototype.hasOwnProperty.call(pc, name)) {
        compareNode(file, child(pointer, 'properties', name), pb[name], bDoc, pc[name], cDoc, stack);
      } else if (isClosed(c) || !(compositionDeclares(c, cDoc, candTree, name) || (scope && scope.declared.has(name)))) {
        // A name an open candidate still declares elsewhere in the
        // composition has moved, not gone.
        report(file, pointer, 'property-removed', `property ${name} removed`);
      }
    }
    // The closed form: the base's, or, for a node the base leaves open, the
    // last earlier release that published it closed.
    const earlier = !isClosed(b) && closedEarlier && bLocation ? closedEarlier.get(bLocation) : undefined;
    const allowed = isClosed(b) ? new Set(Object.keys(pb)) : earlier && earlier.names;
    if (allowed && !(reopened && bLocation && reopened.has(bLocation))) {
      for (const name of Object.keys(pc)) {
        if (allowed.has(name)) continue;
        if (!earlier) {
          report(file, pointer, 'property-added-to-closed', `property ${name} added`);
          continue;
        }
        const released = Object.prototype.hasOwnProperty.call(pb, name);
        report(file, pointer, 'property-added-to-closed', `property ${name} added (closed in ${earlier.release})`,
          released ? { released: true } : null);
      }
    }

    // A name the base already required, here, through an allOf entry, or on
    // an enclosing schema of this composition branch, is not newly required.
    const rb = new Set([...declaredNames(b, bDoc, baseTree, 'required'), ...(scope ? scope.required : [])]);
    for (const name of Array.isArray(c.required) ? c.required : []) {
      if (!rb.has(name)) report(file, pointer, 'required-added', `property ${name} newly required`);
    }
  }

  function compareCompositions(file, pointer, b, bDoc, c, cDoc, stack, outerScope) {
    // Names that this node and its allOf entries declare (in the candidate)
    // or require (in the base) hold for every branch below it.
    const scope = {
      declared: new Set([...(outerScope ? outerScope.declared : []), ...declaredNames(c, cDoc, candTree, 'properties')]),
      required: new Set([...(outerScope ? outerScope.required : []), ...declaredNames(b, bDoc, baseTree, 'required')]),
    };
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
      if (!Array.isArray(b[keyword]) || !Array.isArray(c[keyword])) continue;
      for (const [i, j] of matchBranches(b[keyword], bDoc, c[keyword], cDoc)) {
        compareNode(file, child(pointer, keyword, i), b[keyword][i], bDoc, c[keyword][j], cDoc, stack, scope);
      }
    }
  }

  const files = [...baseTree.documents.keys()].sort();
  for (const key of files) {
    const base = baseTree.documents.get(key);
    const candidate = candTree.documents.get(key);
    if (!candidate) {
      if (!isExperimental(base.schema)) report(key, '', 'file-removed', `schema ${key} removed`);
      continue;
    }
    if (skipIdentical && base.unversioned !== null && base.unversioned === candidate.unversioned) continue;
    compareNode(key, '', base.schema, key, candidate.schema, key, new Set());
  }

  const order = (x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)
    || (x.pointer < y.pointer ? -1 : x.pointer > y.pointer ? 1 : 0)
    || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0)
    || (x.detail < y.detail ? -1 : x.detail > y.detail ? 1 : 0);
  findings.sort(order);
  notices.sort(order);
  return { findings, notices, filesCompared: files.length };
}

/**
 * For each node of `baseTree` that is open, the last of `earlierTrees` that
 * published it closed, and the properties it had there. `earlierTrees` is
 * `[{ version, tree }]`, oldest first: the stable releases of the base's
 * major that precede the base.
 */
function closedInEarlierReleases(baseTree, earlierTrees) {
  const closed = new Map();
  for (const { version, tree } of earlierTrees) {
    // A file identical in both releases has the same closures in both; a $ref
    // that leaves it is followed from the file that differs.
    compareTrees(tree, baseTree, {
      skipIdentical: true,
      onObject: (earlier, _earlierLocation, base, baseLocation) => {
        if (!baseLocation || !isClosed(earlier) || isClosed(base)) return;
        closed.set(baseLocation, {
          release: version,
          names: new Set(isObject(earlier.properties) ? Object.keys(earlier.properties) : []),
        });
      },
    });
  }
  return closed;
}

/** The stable releases of `base`'s major that precede it, oldest first. */
function earlierStableVersions(base, releasedVersions) {
  const parsed = parseVersion(base);
  return releasedVersions
    .map(parseVersion)
    .filter((v) => v && v.major === parsed.major && v.prerelease.length === 0 && compareVersions(v, parsed) < 0)
    .sort(compareVersions)
    .map((v) => v.raw);
}

// ---------------------------------------------------------------------------
// Reopened schemas
// ---------------------------------------------------------------------------

/**
 * Validates the reopened-schemas list and returns the locations whose
 * additions `candidateVersion` may carry: those listed from a release at or
 * below it. A prerelease counts as its release (3.3.0-beta.1 as 3.3.0).
 */
function readReopened(value, candidateVersion) {
  const errors = [];
  const allowed = new Set();
  if (!isObject(value) || !Array.isArray(value.schemas)) {
    return { allowed, entries: [], errors: ['reopened list must be an object with a schemas array'] };
  }
  const candidate = parseVersion(candidateVersion);
  const release = candidate && { ...candidate, prerelease: [] };
  const seen = new Set();
  value.schemas.forEach((entry, index) => {
    const label = `reopened schemas[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    for (const field of ['file', 'pointer', 'since', 'reason']) {
      if (typeof entry[field] !== 'string') errors.push(`${label}.${field} must be a string`);
    }
    if (typeof entry.reason === 'string' && !entry.reason.trim()) errors.push(`${label}.reason must not be empty`);
    if (typeof entry.pointer === 'string' && entry.pointer !== '' && !entry.pointer.startsWith('/')) {
      errors.push(`${label}.pointer must be a JSON pointer`);
    }
    const since = typeof entry.since === 'string' ? parseVersion(entry.since) : null;
    if (typeof entry.since === 'string' && (!since || since.prerelease.length)) {
      errors.push(`${label}.since must be a stable release`);
    }
    const location = `${entry.file}#${entry.pointer}`;
    if (seen.has(location)) errors.push(`${label} duplicates ${location}`);
    seen.add(location);
    if (since && release && compareVersions(release, since) >= 0) allowed.add(location);
  });
  return { allowed, entries: value.schemas, errors };
}

/** A schema listed as reopened must be open in the candidate tree. */
function checkReopenedOpen(allowed, candTree) {
  const errors = [];
  for (const location of allowed) {
    const [key, pointer] = location.split('#');
    const document = candTree.documents.get(key);
    const node = document ? readPointer(document.schema, pointer) : undefined;
    if (!isObject(node)) errors.push(`reopened schema ${location} does not exist in ${candTree.label}`);
    else if (isClosed(node)) errors.push(`reopened schema ${location} is still closed in ${candTree.label}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

function findingKey(entry) {
  return `${entry.file}#${entry.pointer} ${entry.kind}: ${entry.detail}`;
}

function validateBaseline(value) {
  const errors = [];
  if (!isObject(value) || !Array.isArray(value.entries)) {
    return { entries: [], base: null, errors: ['baseline must be an object with an entries array'] };
  }
  const seen = new Set();
  value.entries.forEach((entry, index) => {
    const label = `baseline entries[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    for (const field of ['file', 'pointer', 'kind', 'detail', 'reason']) {
      if (typeof entry[field] !== 'string') errors.push(`${label}.${field} must be a string`);
    }
    if (typeof entry.reason === 'string' && !entry.reason.trim()) errors.push(`${label}.reason must not be empty`);
    if (typeof entry.kind === 'string' && !VIOLATIONS.has(entry.kind)) {
      errors.push(`${label}.kind ${entry.kind} is not a violation kind`);
    }
    const key = findingKey(entry);
    if (seen.has(key)) errors.push(`${label} duplicates ${key}`);
    seen.add(key);
  });
  return { entries: value.entries, base: typeof value.base === 'string' ? value.base : null, errors };
}

function readBaselineAtRef(ref, repoRoot = REPO_ROOT) {
  try {
    return JSON.parse(git(['show', `${ref}:${BASELINE_REPO_PATH}`], { cwd: repoRoot }));
  } catch {
    return null;
  }
}

/**
 * Checks a comparison against a baseline. `previousBaseline` is the baseline
 * on the target branch; any entry it lacks is an error, so the baseline only
 * shrinks.
 */
function checkAgainstBaseline({ base, findings, baselineValue, previousBaseline = null }) {
  const errors = [];
  const warnings = [];
  const baseline = validateBaseline(baselineValue);
  errors.push(...baseline.errors);
  const recorded = new Set(baseline.entries.map(findingKey));
  const found = new Set(findings.map(findingKey));
  const added = findings.filter((v) => !recorded.has(findingKey(v)));
  for (const violation of added) errors.push(`new non-additive change: ${findingKey(violation)}`);

  const stale = baseline.entries.filter((entry) => !found.has(findingKey(entry)));
  const baseMoved = baseline.base !== null && baseline.base !== base;
  for (const entry of stale) {
    const message = `stale baseline entry: ${findingKey(entry)} no longer occurs`;
    if (baseMoved) warnings.push(`${message} (base moved from ${baseline.base} to ${base})`);
    else errors.push(`${message}; remove it from the baseline`);
  }

  if (previousBaseline) {
    // A released finding shipped in a stable release, so no change can undo
    // it within the major. Recording it hides no unreleased change.
    const released = new Set(findings.filter((f) => f.released).map(findingKey));
    const previous = new Set(validateBaseline(previousBaseline).entries.map(findingKey));
    for (const entry of baseline.entries) {
      const key = findingKey(entry);
      if (!previous.has(key) && !released.has(key)) {
        errors.push(`baseline grew: ${key} is not in the target branch baseline`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, added, stale, baseline };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatFindings(findings) {
  return findings.map((f) => `  ${f.file}#${f.pointer}  ${f.kind}  ${f.detail}`);
}

function markdownTable(header, rows) {
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  return [fmt(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(fmt)].join('\n');
}

function formatHistory(results) {
  const label = (r) => `${r.base} → ${r.candidate}${r.patchLine ? ' (patch line)' : ''}`;
  const kinds = VIOLATION_KINDS.filter((kind) => results.some((r) => r.findings.some((f) => f.kind === kind)));
  const out = [
    '## Additive-minor history',
    '',
    markdownTable(
      ['Release pair', 'Files compared', 'Non-additive changes', 'Files affected', 'Closed schemas opened'],
      results.map((r) => [label(r), r.filesCompared, r.findings.length, new Set(r.findings.map((f) => f.file)).size, r.notices.length]),
    ),
    '',
    '### By kind',
    '',
    markdownTable(['Kind', ...results.map((r) => `${r.base} → ${r.candidate}`)],
      kinds.map((kind) => [kind, ...results.map((r) => r.findings.filter((f) => f.kind === kind).length)])),
    '',
    '### Findings',
  ];
  for (const r of results) {
    if (r.findings.length || r.notices.length) {
      out.push('', `${label(r)}:`, '', '```', ...formatFindings(r.findings), ...formatFindings(r.notices), '```');
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Compares a candidate tree with a base, applying the closures of the earlier
 * stable releases in the base's major and the reopened-schemas list.
 * `earlierTrees` defaults to the released trees on disk or in git.
 */
function analyze({
  base,
  baseTree,
  candTree,
  candidateVersion,
  earlierTrees,
  reopenedValue,
  repoRoot = REPO_ROOT,
}) {
  const trees = earlierTrees || (base
    ? earlierStableVersions(base, listReleasedVersions(repoRoot)).map((version) => ({ version, tree: loadReleasedTree(version, repoRoot) }))
    : []);
  const reopened = readReopened(reopenedValue === undefined ? { schemas: [] } : reopenedValue, candidateVersion);
  const errors = [
    ...trees.flatMap(({ tree }) => tree.errors),
    ...reopened.errors,
    ...checkReopenedOpen(reopened.allowed, candTree),
  ];
  const closedEarlier = closedInEarlierReleases(baseTree, trees);
  const result = compareTrees(baseTree, candTree, { closedEarlier, reopened: reopened.allowed });
  return { ...result, errors };
}

function readJsonFile(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

/**
 * CI check: source against the default base, filtered through the baseline.
 * Options exist for tests; the defaults read the repository.
 */
function lintAdditiveMinor({
  repoRoot = REPO_ROOT,
  sourceDir = DEFAULT_SOURCE_DIR,
  baselinePath = DEFAULT_BASELINE_PATH,
  baselineValue,
  reopenedPath = DEFAULT_REOPENED_PATH,
  reopenedValue,
  baseTree,
  baseVersion,
  candidateVersion,
  earlierTrees,
  previousBaseline = null,
} = {}) {
  let base = baseVersion;
  const version = candidateVersion || readSourceVersion(repoRoot);
  if (!baseTree && !base) {
    base = defaultBaseVersion(version, listReleasedVersions(repoRoot));
    if (!base) return { ok: true, skipped: true, base: null, errors: [], warnings: [], findings: [], notices: [] };
  }
  const baseSchemas = baseTree || loadReleasedTree(base, repoRoot);
  const candTree = loadDirectoryTree(sourceDir, 'source');
  const { findings, notices, filesCompared, errors: analysisErrors } = analyze({
    base,
    baseTree: baseSchemas,
    candTree,
    candidateVersion: version,
    earlierTrees: earlierTrees || (baseTree ? [] : undefined),
    reopenedValue: reopenedValue === undefined ? readJsonFile(reopenedPath, { schemas: [] }) : reopenedValue,
    repoRoot,
  });
  const parseErrors = [...baseSchemas.errors, ...candTree.errors, ...analysisErrors];
  const value = baselineValue === undefined ? readJsonFile(baselinePath, { base, entries: [] }) : baselineValue;
  const check = checkAgainstBaseline({ base, findings, baselineValue: value, previousBaseline });
  return {
    ...check,
    ok: check.ok && parseErrors.length === 0,
    errors: [...parseErrors, ...check.errors],
    base,
    findings,
    notices,
    filesCompared,
  };
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const sourceDir = path.resolve(readArg(args, '--source', DEFAULT_SOURCE_DIR));
  const baselinePath = path.resolve(readArg(args, '--baseline', DEFAULT_BASELINE_PATH));
  const reopenedPath = path.resolve(readArg(args, '--reopened', DEFAULT_REOPENED_PATH));
  const options = { repoRoot: REPO_ROOT, sourceDir };

  if (args.includes('--history')) {
    const major = parseVersion(readSourceVersion(REPO_ROOT)).major;
    const { pairs, patchLines } = historyPairs(listReleasedVersions(REPO_ROOT), major);
    const trees = new Map();
    const tree = (spec) => {
      if (!trees.has(spec)) trees.set(spec, loadTreeSpec(spec, options));
      return trees.get(spec);
    };
    const results = [...pairs, ...patchLines].map((pair) => ({ ...pair, ...compareTrees(tree(pair.base), tree(pair.candidate)) }));
    console.log(formatHistory(results));
    return;
  }

  if (args.includes('--base') || args.includes('--candidate')) {
    const candidate = readArg(args, '--candidate', 'source');
    const candidateVersion = candidate === 'source' ? readSourceVersion(REPO_ROOT) : candidate;
    const base = readArg(args, '--base', null) || defaultBaseVersion(candidateVersion, listReleasedVersions(REPO_ROOT));
    if (!base) {
      console.log(`No stable release precedes ${candidateVersion} in its major line; nothing to compare.`);
      return;
    }
    const baseIsRelease = Boolean(parseVersion(base));
    const { findings, notices, filesCompared, errors } = analyze({
      base: baseIsRelease ? base : null,
      baseTree: loadTreeSpec(base, options),
      candTree: loadTreeSpec(candidate, options),
      candidateVersion,
      reopenedValue: readJsonFile(reopenedPath, { schemas: [] }),
    });
    errors.forEach((error) => console.error(`error: ${error}`));
    if (args.includes('--json')) console.log(JSON.stringify([...findings, ...notices], null, 2));
    else {
      console.log([
        `${base} → ${candidate}: ${filesCompared} files compared, ${findings.length} violations, ${notices.length} notices`,
        ...formatFindings(findings),
        ...formatFindings(notices),
      ].join('\n'));
    }
    return;
  }

  if (args.includes('--prune-baseline')) {
    const current = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const result = lintAdditiveMinor({ ...options, baselinePath, reopenedPath, baselineValue: { base: null, entries: [] } });
    if (result.skipped) {
      console.log('No base release; baseline unchanged.');
      return;
    }
    const found = new Set(result.findings.map(findingKey));
    const next = { ...current, base: result.base, entries: current.entries.filter((entry) => found.has(findingKey(entry))) };
    fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Kept ${next.entries.length} of ${current.entries.length} entries (base ${result.base}).`);
    return;
  }

  const baselineRef = readArg(args, '--baseline-ref', process.env[BASELINE_REF_ENV] || '');
  let previousBaseline = null;
  if (baselineRef) {
    previousBaseline = readBaselineAtRef(baselineRef, REPO_ROOT);
    if (!previousBaseline) console.log(`No baseline at ${baselineRef}; skipping the shrink-only check.`);
  }
  const result = lintAdditiveMinor({ ...options, baselinePath, reopenedPath, previousBaseline });
  if (result.skipped) {
    console.log('✓ additive-minor lint: the source major line has no stable release yet; nothing to compare.');
    return;
  }
  for (const notice of result.notices) {
    console.log(notice.reopened
      ? `notice: ${findingKey(notice)}. Reopened under DR-0036 (scripts/lint-additive-minor-reopened.json).`
      : `notice: ${findingKey(notice)}. Opening breaks no validator, but it permits no additions until the next major (DR-0036).`);
  }
  result.warnings.forEach((warning) => console.warn(`warning: ${warning}`));
  if (result.warnings.length) console.warn('Run `node scripts/lint-additive-minor.cjs --prune-baseline` to drop stale entries.');
  if (result.ok) {
    console.log(
      `✓ additive-minor lint: source vs ${result.base}, ${result.filesCompared} files, ` +
      `${result.findings.length} recorded non-additive changes, 0 new (see --base/--candidate for the report)`,
    );
    return;
  }
  console.error(`✗ additive-minor lint (source vs ${result.base}) failed with ${result.errors.length} error(s):\n`);
  result.errors.forEach((error) => console.error(`  - ${error}`));
  if (result.added.length) {
    console.error(
      '\nA minor release only adds. Make the change additive instead: add the property to an open' +
      ' object, keep removed values and properties, and keep new properties optional. If the change' +
      ' has to ship anyway, it needs a WG decision and a major release.',
    );
  }
  process.exitCode = 1;
}

module.exports = {
  NOTICE_KINDS,
  VIOLATION_KINDS,
  analyze,
  buildTree,
  checkAgainstBaseline,
  compareTrees,
  defaultBaseVersion,
  findingKey,
  historyPairs,
  lintAdditiveMinor,
};

if (require.main === module) main();
