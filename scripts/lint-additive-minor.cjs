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
 *   Schemas are open by default. A schema stays closed
 *   (`additionalProperties: false` or `unevaluatedProperties: false`) only for
 *   a structural reason, and a property added to a schema that is closed in
 *   both the base and the candidate is property-added-to-closed: a validator
 *   on the base release rejects it. Opening a closed schema is allowed, and
 *   so is adding to a schema the candidate opens. Closing an open schema is
 *   additional-properties-closed.
 *
 * Notices (never fail)
 *   additional-properties-opened: a closed schema is opened. Opening breaks no
 *   validator.
 *
 * Corrections (DR-0036)
 *   A minor or patch release may tighten a schema only where the published
 *   spec text of the major already set the limit.
 *   scripts/lint-additive-minor-corrections.json lists each one: the schema
 *   location, the change, the release it lands in, and the source text it
 *   rests on. Each source file must exist and contain its quote, and the file
 *   must name an existing decision record under governance/decisions.
 *
 *   A correction may tighten one bound (`bound` and `value`, such as
 *   `minLength` 1) where the published spec text already required it: an
 *   empty identifier that the text says identifies a task. The check accepts
 *   exactly that bound at that location from the listed release on, and the
 *   candidate must carry it there. Any other tightening still fails.
 *
 *   A correction may also require one name (`required`, such as `status`)
 *   that the published text already required. Required names are compared
 *   as composed sets: a node's own `required` plus those of its `allOf`
 *   entries, through `$ref`s, so a name required through a new `allOf`
 *   entry counts. The check accepts exactly that name at that location, and
 *   the candidate's composed set must contain it there.
 *
 * Modes
 *   (default)                    CI: candidate = source, base = default base;
 *                                fails on any violation not in the baseline.
 *   --base <v> --candidate <v|source>
 *                                prints a report; exits 0.
 *   --history                    runs the check across consecutive 3.x
 *                                releases and prints tables and findings.
 *   --prune-baseline             removes stale baseline entries only.
 *   --baseline-ref <git-ref>     also fails when the baseline has an entry
 *                                that the baseline at <git-ref> lacks, so the
 *                                baseline only shrinks. Defaults to
 *                                $ADCP_ADDITIVE_MINOR_BASELINE_REF.
 *
 * Background: DR-0009 makes schemas open by default so that a minor can add
 * optional fields. A minor that adds a field to an object that stays closed
 * breaks a receiver that validates against the earlier release, so 3.3 opens
 * the schemas that were meant to be open (WG, 2026-11-09) and keeps closed
 * only those whose closure enforces something (DR-0036).
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
const DEFAULT_CORRECTIONS_PATH = path.join(REPO_ROOT, 'scripts', 'lint-additive-minor-corrections.json');
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
      if (!resolved || !isObject(resolved.node)) continue;
      // An allOf entry's own allOf entries hold too (see declaredNames).
      const names = keyword === 'allOf'
        ? declaredNames(resolved.node, resolved.docKey, tree, 'properties')
        : new Set(namesIn(resolved.node, 'properties'));
      if (names.has(name)) return true;
    }
  }
  return false;
}

function namesIn(node, keyword) {
  if (keyword === 'required') return Array.isArray(node.required) ? node.required : [];
  return isObject(node.properties) ? Object.keys(node.properties) : [];
}

/**
 * Property names that a node and its `allOf` entries list under `keyword`
 * (`properties` or `required`). `allOf` is a conjunction, so an entry's own
 * `allOf` entries count too: core/protocol-envelope.json declares
 * `adcp_version` through its `allOf` of core/version-envelope.json.
 */
function declaredNames(node, docKey, tree, keyword, seen = new Set()) {
  const names = new Set(namesIn(node, keyword));
  for (const entry of Array.isArray(node.allOf) ? node.allOf : []) {
    const resolved = resolveNode(entry, docKey, tree);
    const identity = resolved && isObject(resolved.node) ? locate(tree, resolved.node) || resolved.node : null;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    declaredNames(resolved.node, resolved.docKey, tree, keyword, seen).forEach((name) => names.add(name));
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
 * `notices`, each `{ file, pointer, kind, detail }`.
 *
 * Options:
 *   corrections    `{ bounds, required }` from readCorrections: the bounds
 *                  and required names a finding location may add.
 *   onObject       Called as (baseNode, baseLocation, candNode, candLocation)
 *                  for every pair of matched object schemas.
 */
function compareTrees(baseTree, candTree, {
  corrections = null,
  onObject = null,
  skipIdentical = false,
} = {}) {
  const findings = [];
  const notices = [];
  const seen = new Set();
  // A recorded required correction: a name a finding location may newly require.
  const requiredCorrected = (file, pointer, name) => Boolean(
    corrections && corrections.required && corrections.required.get(`${file}#${pointer}`)?.has(name),
  );
  // A recorded bound correction: the exact bound value at a finding location.
  const boundCorrected = (file, pointer, keyword, value) => Boolean(
    corrections && corrections.bounds && corrections.bounds.get(`${file}#${pointer}`)?.get(keyword) === value,
  );

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
      if (boundCorrected(file, pointer, keyword, c[keyword])) return;
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
        report(file, pointer, 'additional-properties-opened', `${keyword} false → ${describe(ac, cDoc)}`);
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
    // A node closed on both sides rejects, at the base release, any property
    // the candidate adds. A node the candidate opens takes additions.
    if (isClosed(b) && isClosed(c)) {
      for (const name of Object.keys(pc)) {
        if (!Object.prototype.hasOwnProperty.call(pb, name)) {
          report(file, pointer, 'property-added-to-closed', `property ${name} added`);
        }
      }
    }

    // Compare the composed required sets: the node's own names plus those of
    // its allOf entries, through $refs into composed documents. A name the
    // base already required, here, through an allOf entry, or on an
    // enclosing schema of this composition branch, is not newly required; a
    // name a new allOf entry requires is.
    const rb = new Set([...declaredNames(b, bDoc, baseTree, 'required'), ...(scope ? scope.required : [])]);
    const rc = declaredNames(c, cDoc, candTree, 'required');
    for (const name of rc) {
      if (rb.has(name) || requiredCorrected(file, pointer, name)) continue;
      report(file, pointer, 'required-added', `property ${name} newly required`);
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

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/**
 * A correction's identity: its location and the bound it adds
 * (`minLength: 1`) or the name it requires.
 */
function correctionKey(entry) {
  const change = typeof entry.bound === 'string'
    ? `${entry.bound}: ${entry.value}`
    : `required: ${entry.required}`;
  return `${entry.file}#${entry.pointer} ${change}`;
}

const CORRECTABLE_BOUNDS = new Set([...LOWER_BOUNDS, ...UPPER_BOUNDS]);

/**
 * Validates the corrections list and returns what `candidateVersion` may
 * carry: the corrections whose release is at or below it. A prerelease counts
 * as its release (3.3.0-beta.1 as 3.3.0). Returns
 *   bounds      a Map from a finding location to the bounds (keyword → value)
 *               it may add;
 *   required    a Map from a finding location to the names it may newly
 *               require.
 */
function readCorrections(value, candidateVersion) {
  const errors = [];
  const bounds = new Map();
  const required = new Map();
  if (!isObject(value) || !Array.isArray(value.corrections)) {
    return { bounds, required, entries: [], errors: ['corrections list must be an object with a corrections array'] };
  }
  const candidate = parseVersion(candidateVersion);
  const current = candidate && { ...candidate, prerelease: [] };
  const seen = new Set();
  value.corrections.forEach((entry, index) => {
    const label = `corrections[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const isBound = entry.bound !== undefined;
    const isRequired = entry.required !== undefined;
    if (entry.property !== undefined) {
      errors.push(`${label} lets in a property; opening a schema or adding to an open one needs no correction (DR-0036)`);
      return;
    }
    if (isBound === isRequired) {
      errors.push(`${label} must name exactly one of bound and required`);
      return;
    }
    const changeField = isBound ? 'bound' : 'required';
    for (const field of ['file', 'pointer', changeField, 'release', 'reason']) {
      if (typeof entry[field] !== 'string') errors.push(`${label}.${field} must be a string`);
    }
    for (const field of [changeField, 'reason']) {
      if (typeof entry[field] === 'string' && !entry[field].trim()) errors.push(`${label}.${field} must not be empty`);
    }
    if (isBound) {
      if (typeof entry.bound === 'string' && !CORRECTABLE_BOUNDS.has(entry.bound)) errors.push(`${label}.bound must be a JSON Schema bound keyword`);
      if (typeof entry.value !== 'number') errors.push(`${label}.value must be a number`);
    }
    if (typeof entry.pointer === 'string' && entry.pointer !== '' && !entry.pointer.startsWith('/')) {
      errors.push(`${label}.pointer must be a JSON pointer`);
    }
    const release = typeof entry.release === 'string' ? parseVersion(entry.release) : null;
    if (typeof entry.release === 'string' && (!release || release.prerelease.length)) {
      errors.push(`${label}.release must be a stable release`);
    }
    const source = entry.source;
    if (!isObject(source) || typeof source.path !== 'string' || !source.path.trim()
      || typeof source.quote !== 'string' || !source.quote.trim()) {
      errors.push(`${label}.source must name a path and a quote`);
    }
    const key = correctionKey(entry);
    if (seen.has(key)) errors.push(`${label} duplicates ${key}`);
    seen.add(key);
    if (!release || !current || compareVersions(current, release) < 0) return;
    const location = `${entry.file}#${entry.pointer}`;
    if (isBound) {
      if (typeof entry.bound !== 'string' || typeof entry.value !== 'number') return;
      if (!bounds.has(location)) bounds.set(location, new Map());
      bounds.get(location).set(entry.bound, entry.value);
      return;
    }
    if (typeof entry.required !== 'string') return;
    if (!required.has(location)) required.set(location, new Set());
    required.get(location).add(entry.required);
  });
  return { bounds, required, entries: value.corrections, errors };
}

/**
 * Each correction in effect must be applied in the candidate tree: a
 * corrected bound has its value there (through a `$ref` if the location
 * refers to a shared definition), and a required name is in the composed
 * required set there.
 */
function checkCorrectionsApplied({ bounds = new Map(), required = new Map() }, candTree) {
  const errors = [];
  const nodeAt = (location) => {
    const [key, pointer] = location.split('#');
    const document = candTree.documents.get(key);
    return document ? readPointer(document.schema, pointer) : undefined;
  };
  for (const [location, expected] of bounds) {
    let node = nodeAt(location);
    if (isObject(node) && typeof node.$ref === 'string') {
      const resolved = resolveNode(node, location.split('#')[0], candTree);
      node = resolved ? resolved.node : undefined;
    }
    if (!isObject(node)) {
      errors.push(`correction ${location} does not exist in ${candTree.label}`);
      continue;
    }
    for (const [keyword, value] of expected) {
      if (node[keyword] !== value) errors.push(`correction ${location} does not carry ${keyword}: ${value} in ${candTree.label}`);
    }
  }
  for (const [location, names] of required) {
    const node = nodeAt(location);
    if (!isObject(node)) {
      errors.push(`correction ${location} does not exist in ${candTree.label}`);
      continue;
    }
    const composed = declaredNames(node, location.split('#')[0], candTree, 'required');
    for (const name of names) {
      if (!composed.has(name)) errors.push(`correction ${location} does not require ${name} in ${candTree.label}`);
    }
  }
  return errors;
}

/** Collapses whitespace, so a quote matches text that wraps across lines. */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Reads a source file in one step, so nothing can change it between a check
 * and the read. Returns null when the path is missing or is not a file.
 */
function readSourceText(full) {
  try {
    return collapseWhitespace(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Each correction names the spec text that required it: a file under `root`
 * that must exist and contain the quote.
 */
function checkCorrectionSources(entries, root) {
  const errors = [];
  const texts = new Map();
  const base = path.resolve(root);
  entries.forEach((entry, index) => {
    if (!isObject(entry) || !isObject(entry.source)) return;
    const { path: file, quote } = entry.source;
    if (typeof file !== 'string' || typeof quote !== 'string' || !file.trim() || !quote.trim()) return;
    const label = `corrections[${index}].source`;
    if (!texts.has(file)) {
      const full = path.resolve(base, file);
      texts.set(file, full.startsWith(`${base}${path.sep}`) ? readSourceText(full) : null);
    }
    const text = texts.get(file);
    if (text === null) errors.push(`${label}.path ${file} does not exist`);
    else if (!text.includes(collapseWhitespace(quote))) errors.push(`${label}.quote is not in ${file}`);
  });
  return errors;
}

/**
 * The corrections list names the decision record that governs it, and that
 * record must exist under governance/decisions.
 */
function checkCorrectionsDecision(value, root) {
  if (!isObject(value) || !Array.isArray(value.corrections) || value.corrections.length === 0) return [];
  if (typeof value.decision !== 'string' || !/^DR-\d+$/.test(value.decision)) {
    return ['corrections list must name its decision record, such as DR-0036'];
  }
  const directory = path.join(root, 'governance', 'decisions');
  const record = fs.existsSync(directory)
    ? fs.readdirSync(directory).find((name) => name.startsWith(`${value.decision}-`) && name.endsWith('.md'))
    : undefined;
  return record ? [] : [`no decision record for ${value.decision} under governance/decisions`];
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

function findingKey(entry) {
  return `${entry.file}#${entry.pointer} ${entry.kind}: ${entry.detail}`;
}

const BASELINE_SHAPE_ERROR = 'baseline must be an object with an entries array';

function validateBaseline(value) {
  const errors = [];
  if (!isObject(value) || !Array.isArray(value.entries)) {
    return { entries: [], base: null, errors: [BASELINE_SHAPE_ERROR] };
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

// Only a baseline that is genuinely absent from the ref's tree may skip the
// shrink-only check. A tree lookup decides that without reading the blob; a
// present baseline that cannot be read (failed lazy fetch in a blobless clone)
// or does not parse throws instead of silently disabling the guard.
function readBaselineAtRef(ref, repoRoot = REPO_ROOT, runGit = git) {
  const listed = runGit(['ls-tree', '-z', '--name-only', ref, '--', BASELINE_REPO_PATH], { cwd: repoRoot });
  if (!listed.split('\0').includes(BASELINE_REPO_PATH)) return null;
  const text = runGit(['show', `${ref}:${BASELINE_REPO_PATH}`], { cwd: repoRoot });
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${ref}:${BASELINE_REPO_PATH} is present but is not valid JSON: ${error.message}`);
  }
  // A present file that is not a baseline at all (`null`, `false`, `0`, `""`,
  // no entries array) must not read as absent and skip the shrink-only check.
  // Entry-level problems stay tolerated on the base ref, as
  // checkAgainstBaseline already does when it reads the previous entries.
  if (validateBaseline(value).errors.includes(BASELINE_SHAPE_ERROR)) {
    throw new Error(`${ref}:${BASELINE_REPO_PATH} is present but invalid: ${BASELINE_SHAPE_ERROR}`);
  }
  return value;
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
    const previous = new Set(validateBaseline(previousBaseline).entries.map(findingKey));
    for (const entry of baseline.entries) {
      const key = findingKey(entry);
      if (!previous.has(key)) {
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
 * Compares a candidate tree with a base, applying the recorded corrections.
 * Correction sources and the decision record resolve against `repoRoot`.
 */
function analyze({
  baseTree,
  candTree,
  candidateVersion,
  correctionsValue,
  repoRoot = REPO_ROOT,
}) {
  const value = correctionsValue === undefined ? { corrections: [] } : correctionsValue;
  const corrections = readCorrections(value, candidateVersion);
  const errors = [
    ...corrections.errors,
    ...checkCorrectionSources(corrections.entries, repoRoot),
    ...checkCorrectionsDecision(value, repoRoot),
    ...checkCorrectionsApplied(corrections, candTree),
  ];
  const result = compareTrees(baseTree, candTree, { corrections });
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
  correctionsPath = DEFAULT_CORRECTIONS_PATH,
  correctionsValue,
  baseTree,
  baseVersion,
  candidateVersion,
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
    baseTree: baseSchemas,
    candTree,
    candidateVersion: version,
    correctionsValue: correctionsValue === undefined ? readJsonFile(correctionsPath, { corrections: [] }) : correctionsValue,
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
  const correctionsPath = path.resolve(readArg(args, '--corrections', DEFAULT_CORRECTIONS_PATH));
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
    const { findings, notices, filesCompared, errors } = analyze({
      baseTree: loadTreeSpec(base, options),
      candTree: loadTreeSpec(candidate, options),
      candidateVersion,
      correctionsValue: readJsonFile(correctionsPath, { corrections: [] }),
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
    const result = lintAdditiveMinor({ ...options, baselinePath, correctionsPath, baselineValue: { base: null, entries: [] } });
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
  const result = lintAdditiveMinor({ ...options, baselinePath, correctionsPath, previousBaseline });
  if (result.skipped) {
    console.log('✓ additive-minor lint: the source major line has no stable release yet; nothing to compare.');
    return;
  }
  if (result.notices.length) {
    console.log(`notice: ${result.notices.length} closed schema locations opened since ${result.base}. Opening breaks no validator (DR-0036); see --base/--candidate for the list.`);
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
      ' has to ship anyway, it needs a WG decision and a major release. If the published spec text' +
      ' already required it, add it as a correction to scripts/lint-additive-minor-corrections.json' +
      ' (DR-0036). A correction sets a bound or a required name; to add a property to a closed' +
      ' schema, open the schema instead.',
    );
  }
  process.exitCode = 1;
}

module.exports = {
  readBaselineAtRef,
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
