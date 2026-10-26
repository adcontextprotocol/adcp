#!/usr/bin/env node
/**
 * Additive-minor guard for AdCP schemas: a minor release only adds.
 *
 * A buyer or seller that validates against the published schemas of its
 * release must keep accepting what a later release in the same major line
 * sends. This script compares two schema trees, a base and a candidate, and
 * reports every change that a validator pinned to the base would see as a
 * break.
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
 *   type-narrowed, enum-value-removed, const-changed, enum-introduced,
 *   bound-tightened, pattern-added, format-added,
 *   additional-properties-closed, file-removed.
 *
 * Review (reported, never fail): changes this script cannot classify
 * reliably, such as a changed `pattern`, a `type` added to an untyped schema,
 * a new `oneOf` branch that may overlap an existing one, or an `allOf` entry
 * added. A pure addition to an open object is never reported.
 *
 * Modes
 *   (default)                    CI: candidate = source, base = default base;
 *                                fails on any violation not in the baseline.
 *   --base <v> --candidate <v|source>
 *                                prints a report; exits 0.
 *   --history                    runs the check across consecutive 3.x
 *                                releases and prints summary tables.
 *   --update-baseline            rewrites the baseline from the current
 *                                violations (needs
 *                                ADCP_UPDATE_ADDITIVE_MINOR_BASELINE=1).
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
const UPDATE_ENV = 'ADCP_UPDATE_ADDITIVE_MINOR_BASELINE';
const BASELINE_REF_ENV = 'ADCP_ADDITIVE_MINOR_BASELINE_REF';
const PENDING_REASON = 'pending WG decision';

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
  'enum-introduced',
  'bound-tightened',
  'pattern-added',
  'format-added',
  'additional-properties-closed',
  'file-removed',
];
const REVIEW_KINDS = [
  'property-added-to-constrained',
  'property-added-matching-pattern',
  'property-moved',
  'additional-properties-constrained',
  'type-added',
  'pattern-changed',
  'format-changed',
  'constraint-added',
  'constraint-changed',
  'composition-added',
  'oneof-branch-added',
  'branch-removed',
  'allof-entry-removed',
  'definition-removed',
  'ref-unresolved',
];
const VIOLATIONS = new Set(VIOLATION_KINDS);

// Lower bounds tighten upward; upper bounds tighten downward.
const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];
const SIBLING_BOUND = {
  minimum: 'exclusiveMinimum',
  exclusiveMinimum: 'minimum',
  maximum: 'exclusiveMaximum',
  exclusiveMaximum: 'maximum',
};
// Keywords whose addition or change constrains instances in ways this script
// does not model; reported for review.
const OPAQUE_CONSTRAINTS = [
  'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'dependencies',
  'dependentRequired', 'dependentSchemas', 'additionalItems', 'multipleOf',
];
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
    if (entry.isDirectory()) files.push(...walkJsonFiles(full, root));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(toPosix(path.relative(root, full)));
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

/**
 * Builds a tree from `{ relativePath: text }`. Each document is keyed by its
 * normalized `$id` when it has one inside the AdCP tree, else by its path.
 */
function buildTree(label, rawFiles) {
  const documents = new Map();
  const errors = [];
  for (const [relativePath, text] of rawFiles) {
    if (isDerived(relativePath)) continue;
    let schema;
    try {
      schema = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (error) {
      errors.push(`${label}/${relativePath}: ${error.message}`);
      continue;
    }
    const idKey = schema && typeof schema.$id === 'string' ? normalizeSchemaPath(schema.$id) : null;
    const key = idKey || relativePath;
    if (documents.has(key)) errors.push(`${label}: ${relativePath} and ${documents.get(key).path} share ${key}`);
    else documents.set(key, { key, path: relativePath, schema });
  }
  return { label, documents, errors };
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

function sameSchema(left, leftDoc, right, rightDoc) {
  return stableStringify(canonicalSchema(left, leftDoc)) === stableStringify(canonicalSchema(right, rightDoc));
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
    current = isObject(resolved) ? { ...resolved, ...siblings } : resolved;
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

function hasComposition(node) {
  return ['oneOf', 'anyOf', 'allOf'].some((key) => Array.isArray(node[key]));
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

/** Property names declared by a node and its `allOf` entries, one level deep. */
function declaredProperties(node, docKey, tree) {
  const names = new Set(isObject(node.properties) ? Object.keys(node.properties) : []);
  for (const entry of Array.isArray(node.allOf) ? node.allOf : []) {
    const resolved = resolveNode(entry, docKey, tree);
    if (resolved && isObject(resolved.node) && isObject(resolved.node.properties)) {
      Object.keys(resolved.node.properties).forEach((name) => names.add(name));
    }
  }
  return names;
}

function matchesPatternProperty(node, name) {
  if (!isObject(node.patternProperties)) return false;
  return Object.keys(node.patternProperties).some((pattern) => {
    try {
      return new RegExp(pattern, 'u').test(name);
    } catch {
      return false;
    }
  });
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

function branchLabel(keys, index) {
  const type = BRANCH_KEY_TYPES.find((t) => t !== 'if' && keys[t] !== undefined);
  return type ? `${type}:${keys[type]}` : `#${index}`;
}

const UNION_WRAPPER_KEYS = new Set(['type', 'discriminator']);

function onlyAnnotations(node, except) {
  return Object.keys(node).every((key) => except.has(key) || ANNOTATION_KEYS.has(key) || key.startsWith('x-'));
}

/**
 * Lists a composition's branches as `{ node, doc, index }`. A branch that is
 * a bare `$ref` to a pure union of the same keyword is replaced by the
 * union's branches, unless the other side references the same union, so a
 * list of variants refactored into a shared union file still matches.
 */
function expandBranches(branches, docKey, tree, keyword, otherRefs) {
  const out = [];
  branches.forEach((node, index) => {
    if (keyword !== 'allOf' && isObject(node) && typeof node.$ref === 'string'
      && onlyAnnotations(node, new Set(['$ref'])) && !otherRefs.has(normalizeRef(node.$ref, docKey))) {
      const resolved = resolveNode(node, docKey, tree);
      const target = resolved && resolved.node;
      if (isObject(target) && Array.isArray(target[keyword])
        && onlyAnnotations(target, new Set([keyword, ...UNION_WRAPPER_KEYS]))) {
        target[keyword].forEach((inner) => out.push({ node: inner, doc: resolved.docKey, index }));
        return;
      }
    }
    out.push({ node, doc: docKey, index });
  });
  return out;
}

function branchRefs(branches, docKey) {
  return new Set(branches
    .filter((node) => isObject(node) && typeof node.$ref === 'string')
    .map((node) => normalizeRef(node.$ref, docKey)));
}

/**
 * Pairs base and candidate branches: identical branches first, then by key,
 * then the rest in order when the candidate has at least as many left.
 * Returns pairs of entry positions plus the unpaired entries on each side.
 */
function matchBranches(baseEntries, candEntries) {
  const baseKeys = baseEntries.map((e) => branchKeys(e.node, e.doc));
  const candKeys = candEntries.map((e) => branchKeys(e.node, e.doc));
  const pairs = [];
  const usedBase = new Set();
  const usedCand = new Set();
  const pair = (i, j) => {
    pairs.push([i, j]);
    usedBase.add(i);
    usedCand.add(j);
  };
  const candCanonical = candEntries.map((e) => stableStringify(canonicalSchema(e.node, e.doc)));
  baseEntries.forEach((e, i) => {
    const text = stableStringify(canonicalSchema(e.node, e.doc));
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
  let restBase = baseEntries.map((_, i) => i).filter((i) => !usedBase.has(i));
  let restCand = candEntries.map((_, j) => j).filter((j) => !usedCand.has(j));
  if (restCand.length >= restBase.length) {
    restBase.forEach((i, n) => pair(i, restCand[n]));
    restCand = restCand.slice(restBase.length);
    restBase = [];
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return { pairs, baseOnly: restBase, candOnly: restCand, baseKeys, candKeys };
}

function describeValue(value) {
  return stableStringify(value);
}

function describeTypes(set) {
  return [...set].sort().join('|');
}

/**
 * Compares two schema trees. Returns findings, each
 * `{ file, pointer, kind, severity, detail }`.
 */
function compareTrees(baseTree, candTree) {
  const findings = [];
  const seen = new Set();

  function report(file, pointer, kind, detail) {
    const key = `${file}\u0000${pointer}\u0000${kind}\u0000${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, pointer, kind, severity: VIOLATIONS.has(kind) ? 'violation' : 'review', detail });
  }

  function compareNode(file, pointer, b, bDoc, c, cDoc, stack, scope = null) {
    if (b === undefined || c === undefined) return;
    if (b === false || c === true) return; // nothing to narrow
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
        compareNode(file, pointer, bRest, bDoc, cRest, cDoc, stack, scope);
        return;
      }
      const bResolved = b.$ref !== undefined ? resolveNode(b, bDoc, baseTree) : { node: b, docKey: bDoc };
      const cResolved = c.$ref !== undefined ? resolveNode(c, cDoc, candTree) : { node: c, docKey: cDoc };
      if (!bResolved || !cResolved) {
        const side = !bResolved ? `base ${b.$ref}` : `candidate ${c.$ref}`;
        report(file, pointer, 'ref-unresolved', `cannot resolve ${side}`);
        return;
      }
      const pairKey = `${bRef || `${bDoc}@${pointer}`}|${cRef || `${cDoc}@${pointer}`}`;
      if (stack.has(pairKey)) return;
      const next = new Set(stack).add(pairKey);
      compareNode(file, pointer, bResolved.node, bResolved.docKey, cResolved.node, cResolved.docKey, next, scope);
      return;
    }

    compareType(file, pointer, b, c);
    compareValues(file, pointer, b, c);
    compareBounds(file, pointer, b, c);
    compareStrings(file, pointer, b, c);
    compareObject(file, pointer, b, bDoc, c, cDoc, stack, scope);
    compareArrays(file, pointer, b, bDoc, c, cDoc, stack);
    compareCompositions(file, pointer, b, bDoc, c, cDoc, stack, scope);
    compareOpaque(file, pointer, b, bDoc, c, cDoc);
    for (const keyword of ['definitions', '$defs']) {
      if (!isObject(b[keyword])) continue;
      for (const name of Object.keys(b[keyword])) {
        const p = child(pointer, keyword, name);
        if (!isObject(c[keyword]) || !(name in c[keyword])) report(file, p, 'definition-removed', `definition ${name} removed`);
        else compareNode(file, p, b[keyword][name], bDoc, c[keyword][name], cDoc, stack);
      }
    }
  }

  function compareType(file, pointer, b, c) {
    const tb = typeSet(b);
    const tc = typeSet(c);
    if (!tc) return;
    if (!tb) {
      report(file, pointer, 'type-added', `type ${describeTypes(tc)} added`);
      return;
    }
    const lost = [...tb].filter((t) => !tc.has(t) && !(t === 'integer' && tc.has('number')));
    if (lost.length) report(file, pointer, 'type-narrowed', `type ${describeTypes(tb)} → ${describeTypes(tc)}`);
  }

  function compareValues(file, pointer, b, c) {
    const vb = valueSet(b);
    const vc = valueSet(c);
    if (!vc) return;
    if (!vb) {
      const what = c.const !== undefined ? `const ${describeValue(c.const)}` : `enum of ${vc.length}`;
      report(file, pointer, hasComposition(b) ? 'constraint-added' : 'enum-introduced', `${what} added`);
      return;
    }
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
      if (typeof b[keyword] === 'number') {
        if (tighter(c[keyword], b[keyword])) {
          report(file, pointer, 'bound-tightened', `${keyword} ${b[keyword]} → ${c[keyword]}`);
        }
        return;
      }
      const sibling = SIBLING_BOUND[keyword];
      if (sibling && typeof b[sibling] === 'number') {
        report(file, pointer, 'constraint-changed', `${sibling} ${b[sibling]} → ${keyword} ${c[keyword]}`);
        return;
      }
      report(file, pointer, 'bound-tightened', `${keyword} ${c[keyword]} added`);
    };
    LOWER_BOUNDS.forEach((keyword) => check(keyword, (next, prev) => next > prev));
    UPPER_BOUNDS.forEach((keyword) => check(keyword, (next, prev) => next < prev));
    if (c.uniqueItems === true && b.uniqueItems !== true) report(file, pointer, 'bound-tightened', 'uniqueItems true added');
  }

  function compareStrings(file, pointer, b, c) {
    for (const [keyword, added, changed] of [
      ['pattern', 'pattern-added', 'pattern-changed'],
      ['format', 'format-added', 'format-changed'],
    ]) {
      if (typeof c[keyword] !== 'string' || b[keyword] === c[keyword]) continue;
      if (typeof b[keyword] !== 'string') report(file, pointer, added, `${keyword} ${JSON.stringify(c[keyword])} added`);
      else report(file, pointer, changed, `${keyword} ${JSON.stringify(b[keyword])} → ${JSON.stringify(c[keyword])}`);
    }
  }

  function compareObject(file, pointer, b, bDoc, c, cDoc, stack, scope) {
    for (const keyword of ['additionalProperties', 'unevaluatedProperties']) {
      const ab = b[keyword];
      const ac = c[keyword];
      const p = child(pointer, keyword);
      if (ac === false && ab !== false) {
        report(file, pointer, 'additional-properties-closed', `${keyword} ${ab === undefined ? 'absent' : stableStringify(canonicalSchema(ab, bDoc))} → false`);
      } else if (isObject(ac) && (ab === undefined || ab === true)) {
        report(file, pointer, 'additional-properties-constrained', `${keyword} ${ab === undefined ? 'absent' : 'true'} → schema`);
      } else if (isObject(ab) && isObject(ac)) {
        compareNode(file, p, ab, bDoc, ac, cDoc, stack);
      }
    }

    const pb = isObject(b.properties) ? b.properties : {};
    const pc = isObject(c.properties) ? c.properties : {};
    for (const name of Object.keys(pb)) {
      if (Object.prototype.hasOwnProperty.call(pc, name)) {
        compareNode(file, child(pointer, 'properties', name), pb[name], bDoc, pc[name], cDoc, stack);
      } else if (!isClosed(c) && (compositionDeclares(c, cDoc, candTree, name) || (scope && scope.has(name)))) {
        report(file, pointer, 'property-moved', `property ${name} still declared elsewhere in the composition`);
      } else {
        report(file, pointer, 'property-removed', `property ${name} removed`);
      }
    }
    const added = Object.keys(pc).filter((name) => !Object.prototype.hasOwnProperty.call(pb, name));
    for (const name of added) {
      if (isClosed(b)) {
        if (matchesPatternProperty(b, name)) {
          report(file, pointer, 'property-added-matching-pattern', `property ${name} added; base patternProperties admit it`);
        } else if (b.additionalProperties !== false && compositionDeclares(b, bDoc, baseTree, name)) {
          report(file, pointer, 'property-moved', `property ${name} moved out of a composition branch`);
        } else {
          report(file, pointer, 'property-added-to-closed', `property ${name} added`);
        }
      } else if (isObject(b.additionalProperties)) {
        report(file, pointer, 'property-added-to-constrained', `property ${name} added; base additionalProperties constrains it`);
      }
    }

    const rb = new Set(Array.isArray(b.required) ? b.required : []);
    for (const name of Array.isArray(c.required) ? c.required : []) {
      if (!rb.has(name)) report(file, pointer, 'required-added', `property ${name} newly required`);
    }

    const ppb = isObject(b.patternProperties) ? b.patternProperties : {};
    const ppc = isObject(c.patternProperties) ? c.patternProperties : {};
    for (const pattern of Object.keys(ppc)) {
      const p = child(pointer, 'patternProperties', pattern);
      if (pattern in ppb) compareNode(file, p, ppb[pattern], bDoc, ppc[pattern], cDoc, stack);
      else if (!isClosed(b)) report(file, pointer, 'constraint-added', `patternProperties ${JSON.stringify(pattern)} added`);
    }
  }

  function compareArrays(file, pointer, b, bDoc, c, cDoc, stack) {
    if (c.items === undefined) return;
    if (b.items === undefined) {
      if (!sameSchema({}, bDoc, c.items, cDoc)) report(file, pointer, 'constraint-added', 'items added');
      return;
    }
    if (Array.isArray(b.items) !== Array.isArray(c.items)) {
      report(file, pointer, 'constraint-changed', 'items changed between list and tuple form');
      return;
    }
    if (!Array.isArray(c.items)) {
      compareNode(file, child(pointer, 'items'), b.items, bDoc, c.items, cDoc, stack);
      return;
    }
    c.items.forEach((item, i) => {
      if (i < b.items.length) compareNode(file, child(pointer, 'items', i), b.items[i], bDoc, item, cDoc, stack);
    });
  }

  function compareCompositions(file, pointer, b, bDoc, c, cDoc, stack, outerScope) {
    // Names declared by this node and its allOf entries stay declared for
    // every branch below it.
    const scope = new Set([...(outerScope || []), ...declaredProperties(c, cDoc, candTree)]);
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
      const bb = Array.isArray(b[keyword]) ? b[keyword] : null;
      const cb = Array.isArray(c[keyword]) ? c[keyword] : null;
      if (!cb) continue;
      if (!bb) {
        report(file, pointer, 'composition-added', `${keyword} added`);
        continue;
      }
      const baseEntries = expandBranches(bb, bDoc, baseTree, keyword, branchRefs(cb, cDoc));
      const candEntries = expandBranches(cb, cDoc, candTree, keyword, branchRefs(bb, bDoc));
      const match = matchBranches(baseEntries, candEntries);
      for (const [i, j] of match.pairs) {
        const be = baseEntries[i];
        const ce = candEntries[j];
        compareNode(file, child(pointer, keyword, be.index), be.node, be.doc, ce.node, ce.doc, stack, scope);
      }
      for (const i of match.baseOnly) {
        const label = branchLabel(match.baseKeys[i], baseEntries[i].index);
        report(file, child(pointer, keyword, baseEntries[i].index), keyword === 'allOf' ? 'allof-entry-removed' : 'branch-removed', `${keyword} branch ${label} removed`);
      }
      for (const j of match.candOnly) {
        const label = branchLabel(match.candKeys[j], candEntries[j].index);
        if (keyword === 'allOf') {
          report(file, pointer, 'composition-added', `allOf entry ${label} added`);
        } else if (keyword === 'oneOf') {
          const discriminated = [...match.baseKeys, match.candKeys[j]].every((keys) => keys.disc !== undefined);
          if (!discriminated) report(file, pointer, 'oneof-branch-added', `oneOf branch ${label} added; may overlap an existing branch`);
        }
      }
    }
  }

  function compareOpaque(file, pointer, b, bDoc, c, cDoc) {
    for (const keyword of OPAQUE_CONSTRAINTS) {
      if (c[keyword] === undefined) continue;
      if (b[keyword] === undefined) report(file, pointer, 'constraint-added', `${keyword} added`);
      else if (!sameSchema(b[keyword], bDoc, c[keyword], cDoc)) report(file, pointer, 'constraint-changed', `${keyword} changed`);
    }
  }

  const files = [...baseTree.documents.keys()].sort();
  for (const key of files) {
    const base = baseTree.documents.get(key);
    const candidate = candTree.documents.get(key);
    if (!candidate) {
      report(key, '', 'file-removed', `schema ${key} removed`);
      continue;
    }
    compareNode(key, '', base.schema, key, candidate.schema, key, new Set());
  }

  findings.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)
    || (x.pointer < y.pointer ? -1 : x.pointer > y.pointer ? 1 : 0)
    || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0)
    || (x.detail < y.detail ? -1 : x.detail > y.detail ? 1 : 0));
  return { findings, filesCompared: files.length };
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

function buildBaseline(base, violations, previous = []) {
  const reasons = new Map(previous.map((entry) => [findingKey(entry), entry.reason]));
  return {
    $comment:
      'Non-additive schema changes recorded by scripts/lint-additive-minor.cjs, relative to the release named in base. This list only shrinks: CI rejects an entry that the target branch does not have. Remove an entry when its change is reverted or released; record a WG decision in reason.',
    base,
    entries: violations.map(({ file, pointer, kind, detail }) => ({
      file,
      pointer,
      kind,
      detail,
      reason: reasons.get(findingKey({ file, pointer, kind, detail })) || PENDING_REASON,
    })),
  };
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
  const violations = findings.filter((f) => f.severity === 'violation');
  const recorded = new Set(baseline.entries.map(findingKey));
  const found = new Set(violations.map(findingKey));
  const added = violations.filter((v) => !recorded.has(findingKey(v)));
  for (const violation of added) errors.push(`new non-additive change: ${findingKey(violation)}`);

  const stale = baseline.entries.filter((entry) => !found.has(findingKey(entry)));
  const baseMoved = baseline.base !== null && baseline.base !== base;
  for (const entry of stale) {
    const message = `stale baseline entry: ${findingKey(entry)} no longer occurs`;
    if (baseMoved) warnings.push(`${message} (base moved from ${baseline.base} to ${base})`);
    else errors.push(`${message}; remove it from the baseline`);
  }

  if (previousBaseline) {
    const before = validateBaseline(previousBaseline);
    const previous = new Set(before.entries.map(findingKey));
    for (const entry of baseline.entries) {
      if (!previous.has(findingKey(entry))) {
        errors.push(`baseline grew: ${findingKey(entry)} is not in the target branch baseline`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, added, stale, violations, baseline };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatReport(label, result) {
  const lines = [];
  const violations = result.findings.filter((f) => f.severity === 'violation');
  const reviews = result.findings.filter((f) => f.severity === 'review');
  lines.push(`${label}: ${result.filesCompared} files compared, ${violations.length} violations, ${reviews.length} for review`);
  for (const [severity, list] of [['violation', violations], ['review', reviews]]) {
    if (!list.length) continue;
    lines.push('', `${severity === 'violation' ? 'Violations' : 'For review'}:`);
    for (const f of list) lines.push(`  ${f.file}#${f.pointer}  ${f.kind}  ${f.detail}`);
  }
  return lines.join('\n');
}

function markdownTable(header, rows) {
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  return [fmt(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(fmt)].join('\n');
}

function formatHistory(results) {
  const label = ({ base, candidate }) => `${base} → ${candidate}`;
  const summary = results.map((r) => {
    const violations = r.findings.filter((f) => f.severity === 'violation');
    const reviews = r.findings.filter((f) => f.severity === 'review');
    const closedFiles = new Set(violations.filter((f) => f.kind === 'property-added-to-closed').map((f) => f.file));
    return [
      label(r) + (r.patchLine ? ' (patch line)' : ''),
      r.filesCompared,
      violations.length,
      new Set(violations.map((f) => f.file)).size,
      closedFiles.size,
      reviews.length,
    ];
  });
  const kinds = VIOLATION_KINDS.filter((kind) => results.some((r) => r.findings.some((f) => f.kind === kind)));
  const reviewKinds = REVIEW_KINDS.filter((kind) => results.some((r) => r.findings.some((f) => f.kind === kind)));
  const byKind = (kindList) => kindList.map((kind) => [kind, ...results.map((r) => r.findings.filter((f) => f.kind === kind).length)]);
  return [
    '### Summary by release pair',
    '',
    markdownTable(
      ['Release pair', 'Files compared', 'Violations', 'Files with violations', 'Files with a property added to a closed object', 'For review'],
      summary,
    ),
    '',
    '### Violations by kind',
    '',
    markdownTable(['Kind', ...results.map(label)], byKind(kinds)),
    '',
    '### For review by kind (not failures)',
    '',
    markdownTable(['Kind', ...results.map(label)], byKind(reviewKinds)),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function compareSpecs(baseSpec, candidateSpec, options = {}) {
  const baseTree = loadTreeSpec(baseSpec, options);
  const candTree = loadTreeSpec(candidateSpec, options);
  const result = compareTrees(baseTree, candTree);
  return { base: baseSpec, candidate: candidateSpec, ...result, errors: [...baseTree.errors, ...candTree.errors] };
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
  baseTree,
  baseVersion,
  previousBaseline = null,
} = {}) {
  let base = baseVersion;
  if (!baseTree && !base) {
    base = defaultBaseVersion(readSourceVersion(repoRoot), listReleasedVersions(repoRoot));
    if (!base) return { ok: true, skipped: true, base: null, errors: [], warnings: [], findings: [] };
  }
  const baseSchemas = baseTree || loadReleasedTree(base, repoRoot);
  const candTree = loadDirectoryTree(sourceDir, 'source');
  const parseErrors = [...baseSchemas.errors, ...candTree.errors];
  const { findings, filesCompared } = compareTrees(baseSchemas, candTree);
  let value = baselineValue;
  if (value === undefined) {
    value = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { base, entries: [] };
  }
  const check = checkAgainstBaseline({ base, findings, baselineValue: value, previousBaseline });
  return {
    ...check,
    ok: check.ok && parseErrors.length === 0,
    errors: [...parseErrors, ...check.errors],
    base,
    findings,
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
  const options = { repoRoot: REPO_ROOT, sourceDir };

  if (args.includes('--history')) {
    const released = listReleasedVersions(REPO_ROOT);
    const major = parseVersion(readSourceVersion(REPO_ROOT)).major;
    const { pairs, patchLines } = historyPairs(released, major);
    const trees = new Map();
    const tree = (spec) => {
      if (!trees.has(spec)) {
        const loaded = loadTreeSpec(spec, options);
        loaded.errors.forEach((error) => console.error(`warning: ${error}`));
        trees.set(spec, loaded);
      }
      return trees.get(spec);
    };
    const run = (list) => list.map((pair) => ({ ...pair, ...compareTrees(tree(pair.base), tree(pair.candidate)) }));
    const chain = run(pairs);
    const lines = run(patchLines);
    if (args.includes('--json')) {
      const slim = (list) => list.map(({ base, candidate, filesCompared, findings }) => ({ base, candidate, filesCompared, findings }));
      console.log(JSON.stringify({ chain: slim(chain), patchLines: slim(lines) }, null, 2));
      return;
    }
    console.log(formatHistoryReport(chain, lines));
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
    const result = compareSpecs(base, candidate, options);
    if (args.includes('--json')) console.log(JSON.stringify(result.findings, null, 2));
    else console.log(formatReport(`${base} → ${candidate}`, result));
    if (result.errors.length) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    }
    return;
  }

  if (args.includes('--update-baseline') || args.includes('--prune-baseline')) {
    const prune = args.includes('--prune-baseline');
    if (!prune && process.env[UPDATE_ENV] !== '1') {
      console.error(`Refusing to rewrite the baseline without ${UPDATE_ENV}=1. Use --prune-baseline to remove stale entries only.`);
      process.exitCode = 2;
      return;
    }
    const current = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { entries: [] };
    const result = lintAdditiveMinor({ ...options, baselinePath, baselineValue: { base: null, entries: [] } });
    if (result.skipped) {
      console.log('No base release; baseline unchanged.');
      return;
    }
    let violations = result.violations;
    if (prune) {
      const kept = new Set(current.entries.map(findingKey));
      violations = violations.filter((v) => kept.has(findingKey(v)));
    }
    const next = buildBaseline(result.base, violations, current.entries);
    fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Wrote ${next.entries.length} entries (base ${result.base}) to ${toPosix(path.relative(REPO_ROOT, baselinePath))}.`);
    return;
  }

  const baselineRef = readArg(args, '--baseline-ref', process.env[BASELINE_REF_ENV] || '');
  let previousBaseline = null;
  if (baselineRef) {
    previousBaseline = readBaselineAtRef(baselineRef, REPO_ROOT);
    if (!previousBaseline) console.log(`No baseline at ${baselineRef}; skipping the shrink-only check.`);
  }
  const result = lintAdditiveMinor({ ...options, baselinePath, previousBaseline });
  if (result.skipped) {
    console.log('✓ additive-minor lint: the source major line has no stable release yet; nothing to compare.');
    return;
  }
  result.warnings.forEach((warning) => console.warn(`warning: ${warning}`));
  if (result.warnings.length) console.warn('Run `node scripts/lint-additive-minor.cjs --prune-baseline` to drop stale entries.');
  const reviews = result.findings.filter((f) => f.severity === 'review').length;
  if (result.ok) {
    console.log(
      `✓ additive-minor lint: source vs ${result.base}, ${result.filesCompared} files, ` +
      `${result.violations.length} recorded non-additive changes, 0 new, ${reviews} for review ` +
      '(see --base/--candidate for the report)',
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

function formatHistoryReport(chain, patchLines) {
  const out = ['## Additive-minor history', '', formatHistory(chain)];
  if (patchLines.length) {
    out.push('', '## Patch lines (first to last patch of each earlier minor)', '', formatHistory(patchLines));
  }
  return out.join('\n');
}

module.exports = {
  PENDING_REASON,
  REVIEW_KINDS,
  VIOLATION_KINDS,
  buildBaseline,
  buildTree,
  checkAgainstBaseline,
  compareTrees,
  compareVersions,
  defaultBaseVersion,
  findingKey,
  historyPairs,
  lintAdditiveMinor,
  loadDirectoryTree,
  normalizeSchemaPath,
  validateBaseline,
};

if (require.main === module) main();
