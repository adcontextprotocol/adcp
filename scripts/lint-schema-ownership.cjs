#!/usr/bin/env node
/**
 * Dependency-direction guard for AdCP source schemas.
 *
 * Every schema file has one owner: the shared tier (core vocabulary, enums,
 * protocol envelopes) or a protocol domain keyed to `supported_protocols`
 * (media_buy, creative, signals, governance, ...). Ownership lives in
 * scripts/schema-ownership.json, not in the schema files, so the published
 * schemas don't change.
 *
 * Rules, applied to every cross-file `$ref`:
 *   - shared → shared and domain → shared are always allowed;
 *   - domain → same domain is allowed;
 *   - domain A → domain B is allowed only when A lists B in `may_depend_on`,
 *     and the declared domain graph must be acyclic;
 *   - shared → domain is never allowed: shared vocabulary must not depend on
 *     a protocol domain.
 *
 * Aggregation files (the schema index and unions of every task response)
 * reference every domain by design; files listed under `aggregations` are
 * exempt from the outgoing-ref check.
 *
 * Crossings that existed when the lint landed are recorded in
 * scripts/lint-schema-ownership-baseline.json. The lint fails on any crossing
 * not in the baseline and on baseline entries that no longer occur, so the
 * baseline only shrinks. Background: adcontextprotocol/adcp#8359 (Part 1).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const DEFAULT_OWNERSHIP_PATH = path.join(REPO_ROOT, 'scripts', 'schema-ownership.json');
const DEFAULT_BASELINE_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'lint-schema-ownership-baseline.json',
);
const SHARED = 'shared';
const RULES = new Set(['shared-to-domain', 'undeclared-domain-dependency']);

// Keys whose values are instance data, not schemas. A property *named* one of
// these is still a schema, so the skip only applies outside property maps.
const DATA_KEYS = new Set(['examples', 'example', 'default', 'const', 'enum']);
const PROPERTY_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependencies',
  'dependentSchemas',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walkJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(fullPath);
  }
  return files.sort();
}

function normalizeSchemaPath(value) {
  let normalized = value;
  if (/^https?:\/\//.test(normalized)) {
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      return null;
    }
    if (parsed.origin !== 'https://adcontextprotocol.org') return null;
    normalized = parsed.pathname;
  }
  // Version-pinned refs point at released artifacts, not the source tree.
  if (/^\/schemas\/v[^/]+\//.test(normalized)) return null;
  normalized = normalized.replace(/^\/schemas\/latest\//, '/schemas/');
  normalized = normalized.replace(/^\/schemas\//, '');
  return normalized.replace(/^\.\//, '');
}

function loadSchemaRegistry(schemasDir = DEFAULT_SCHEMAS_DIR) {
  const documents = [];
  const byKey = new Map();
  const parseErrors = [];
  for (const file of walkJsonFiles(schemasDir)) {
    const relativePath = toPosix(path.relative(schemasDir, file));
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      parseErrors.push(`${relativePath}: ${error.message}`);
      continue;
    }
    const document = { relativePath, schema };
    documents.push(document);
    byKey.set(relativePath, document);
    if (schema && typeof schema.$id === 'string') {
      const key = normalizeSchemaPath(schema.$id);
      if (key) byKey.set(key, document);
    }
  }
  return { documents, byKey, parseErrors };
}

function collectRefs(node, parentKey = null, refs = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, parentKey, refs);
    return refs;
  }
  if (!node || typeof node !== 'object') return refs;
  const inPropertyMap = PROPERTY_MAP_KEYS.has(parentKey);
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && !inPropertyMap) {
      refs.push(value);
      continue;
    }
    if (!inPropertyMap && DATA_KEYS.has(key)) continue;
    collectRefs(value, key, refs);
  }
  return refs;
}

function resolveRefTarget(ref, fromPath, registry) {
  const base = ref.split('#')[0];
  if (!base) return null; // same-document ref
  const key = base.startsWith('.')
    ? toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), base)))
    : normalizeSchemaPath(base);
  if (!key) return null;
  const document = registry.byKey.get(key);
  return document ? document.relativePath : null;
}

/**
 * Builds a file → owner resolver from the ownership config. Exact file
 * overrides win, then the longest matching path prefix.
 */
function buildOwnership(config) {
  const errors = [];
  const prefixes = [];
  const domains = new Map();
  const seenPrefixes = new Map();

  function addPrefix(prefix, owner, label) {
    if (typeof prefix !== 'string' || !prefix || prefix.startsWith('/')) {
      errors.push(`${label}: path must be a schema-relative file or directory prefix`);
      return;
    }
    if (seenPrefixes.has(prefix)) {
      errors.push(`${label}: path ${prefix} is already owned by ${seenPrefixes.get(prefix)}`);
      return;
    }
    seenPrefixes.set(prefix, owner);
    prefixes.push({ prefix, owner });
  }

  if (!config || typeof config !== 'object') {
    return { errors: ['ownership config must be an object'] };
  }
  (Array.isArray(config.shared) ? config.shared : []).forEach((prefix, index) =>
    addPrefix(prefix, SHARED, `shared[${index}]`));
  if (!Array.isArray(config.shared)) errors.push('shared must be an array of paths');

  const domainEntries = config.domains && typeof config.domains === 'object'
    ? Object.entries(config.domains)
    : [];
  if (domainEntries.length === 0) errors.push('domains must declare at least one domain');
  for (const [name, domain] of domainEntries) {
    if (name === SHARED) {
      errors.push(`domains.${name}: "${SHARED}" is reserved`);
      continue;
    }
    const paths = Array.isArray(domain && domain.paths) ? domain.paths : [];
    const mayDependOn = Array.isArray(domain && domain.may_depend_on) ? domain.may_depend_on : [];
    if (paths.length === 0) errors.push(`domains.${name}.paths must list at least one path`);
    paths.forEach((prefix, index) => addPrefix(prefix, name, `domains.${name}.paths[${index}]`));
    domains.set(name, new Set(mayDependOn));
  }
  for (const [name, mayDependOn] of domains) {
    for (const target of mayDependOn) {
      if (target === name) errors.push(`domains.${name}.may_depend_on lists itself`);
      else if (!domains.has(target)) {
        errors.push(`domains.${name}.may_depend_on names unknown domain ${target}`);
      }
    }
  }
  const cycle = findCycle(domains);
  if (cycle) errors.push(`declared domain dependencies form a cycle: ${cycle.join(' → ')}`);

  const files = config.files && typeof config.files === 'object' ? config.files : {};
  const aggregations = new Set(Array.isArray(config.aggregations) ? config.aggregations : []);
  if (config.aggregations !== undefined && !Array.isArray(config.aggregations)) {
    errors.push('aggregations must be an array of schema files');
  }
  for (const [file, owner] of Object.entries(files)) {
    if (owner !== SHARED && !domains.has(owner)) {
      errors.push(`files.${file}: unknown owner ${owner}`);
    }
  }

  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  function ownerOf(relativePath) {
    if (Object.prototype.hasOwnProperty.call(files, relativePath)) return files[relativePath];
    const match = prefixes.find(({ prefix }) =>
      prefix.endsWith('/') ? relativePath.startsWith(prefix) : relativePath === prefix);
    return match ? match.owner : null;
  }

  return { errors, domains, files, aggregations, ownerOf };
}

function findCycle(domains) {
  const state = new Map();
  const stack = [];
  function visit(name) {
    state.set(name, 'visiting');
    stack.push(name);
    for (const next of domains.get(name) || []) {
      if (!domains.has(next)) continue;
      if (state.get(next) === 'visiting') return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  }
  for (const name of [...domains.keys()].sort()) {
    if (!state.has(name)) {
      const cycle = visit(name);
      if (cycle) return cycle;
    }
  }
  return null;
}

function classifyEdge(fromOwner, toOwner, domains) {
  if (toOwner === SHARED || fromOwner === toOwner) return null;
  if (fromOwner === SHARED) return 'shared-to-domain';
  return domains.get(fromOwner).has(toOwner) ? null : 'undeclared-domain-dependency';
}

/** Returns every file-to-file crossing, deduplicated per (from, to). */
function collectCrossings(registry, ownership) {
  const crossings = new Map();
  const unowned = [];
  let crossFileRefs = 0;
  for (const document of registry.documents) {
    const fromOwner = ownership.ownerOf(document.relativePath);
    if (!fromOwner) {
      unowned.push(document.relativePath);
      continue;
    }
    if (ownership.aggregations.has(document.relativePath)) continue;
    for (const ref of collectRefs(document.schema)) {
      const target = resolveRefTarget(ref, document.relativePath, registry);
      if (!target || target === document.relativePath) continue;
      const toOwner = ownership.ownerOf(target);
      if (!toOwner) continue; // reported once, as the target's own unowned entry
      crossFileRefs += 1;
      const rule = classifyEdge(fromOwner, toOwner, ownership.domains);
      if (!rule) continue;
      const key = `${document.relativePath} → ${target}`;
      if (!crossings.has(key)) {
        crossings.set(key, {
          key,
          from: document.relativePath,
          to: target,
          fromOwner,
          toOwner,
          rule,
        });
      }
    }
  }
  return {
    crossings: [...crossings.values()].sort((a, b) => a.key.localeCompare(b.key)),
    unowned,
    crossFileRefs,
  };
}

function validateBaseline(value) {
  const errors = [];
  const entries = value && Array.isArray(value.entries) ? value.entries : null;
  if (!entries) return { entries: [], errors: ['baseline must contain an entries array'] };
  const seen = new Set();
  entries.forEach((entry, index) => {
    const label = `baseline entries[${index}]`;
    if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      errors.push(`${label} must have string from and to`);
      return;
    }
    if (!RULES.has(entry.rule)) {
      errors.push(`${label}.rule must be one of: ${[...RULES].join(', ')}`);
    }
    const key = `${entry.from} → ${entry.to}`;
    if (seen.has(key)) errors.push(`${label} duplicates ${key}`);
    seen.add(key);
  });
  return { entries, errors };
}

function readJson(file, label) {
  if (!fs.existsSync(file)) return { error: `missing ${label}: ${file}` };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: `invalid ${label} JSON: ${error.message}` };
  }
}

function lintSchemaOwnership({
  schemasDir = DEFAULT_SCHEMAS_DIR,
  ownershipPath = DEFAULT_OWNERSHIP_PATH,
  baselinePath = DEFAULT_BASELINE_PATH,
  ownershipValue,
  baselineValue,
} = {}) {
  const errors = [];
  const registry = loadSchemaRegistry(schemasDir);
  errors.push(...registry.parseErrors.map((error) => `schema parse error: ${error}`));

  let config = ownershipValue;
  if (config === undefined) {
    const read = readJson(ownershipPath, 'ownership config');
    if (read.error) return { ok: false, errors: [...errors, read.error], crossings: [] };
    config = read.value;
  }
  const ownership = buildOwnership(config);
  if (ownership.errors.length > 0) {
    return { ok: false, errors: [...errors, ...ownership.errors], crossings: [] };
  }

  let baselineRaw = baselineValue;
  if (baselineRaw === undefined) {
    const read = readJson(baselinePath, 'baseline');
    if (read.error) errors.push(read.error);
    baselineRaw = read.value;
  }
  const baseline = validateBaseline(baselineRaw);
  errors.push(...baseline.errors);

  for (const file of Object.keys(ownership.files)) {
    if (!registry.byKey.has(file)) errors.push(`files.${file}: no such schema file`);
  }
  for (const file of ownership.aggregations) {
    if (!registry.byKey.has(file)) errors.push(`aggregations: no such schema file ${file}`);
  }

  const { crossings, unowned, crossFileRefs } = collectCrossings(registry, ownership);
  for (const file of unowned) {
    errors.push(`unowned schema file: ${file} — add its directory to scripts/schema-ownership.json`);
  }

  const recorded = new Map(baseline.entries.map((entry) => [`${entry.from} → ${entry.to}`, entry]));
  const found = new Set(crossings.map((crossing) => crossing.key));
  const added = crossings.filter((crossing) => !recorded.has(crossing.key));
  for (const crossing of added) {
    errors.push(
      `new ${crossing.rule}: ${crossing.key} (${crossing.fromOwner} → ${crossing.toOwner})`,
    );
  }
  for (const [key, entry] of recorded) {
    if (!found.has(key)) {
      errors.push(`stale baseline entry: ${key} no longer crosses; remove it from the baseline`);
    } else {
      const current = crossings.find((crossing) => crossing.key === key);
      if (current.rule !== entry.rule) {
        errors.push(`baseline entry ${key} records ${entry.rule} but the crossing is now ${current.rule}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    crossings,
    added,
    crossFileRefs,
    files: registry.documents.length,
    baseline: baseline.entries,
    ownership,
    registry,
  };
}

/**
 * For shared files with exactly one consuming domain, suggests that domain as
 * the owner. Advisory input for follow-up ownership PRs, never enforced.
 */
function suggestOwners(registry, ownership) {
  const consumers = new Map();
  for (const document of registry.documents) {
    const fromOwner = ownership.ownerOf(document.relativePath);
    if (!fromOwner || fromOwner === SHARED) continue;
    for (const ref of collectRefs(document.schema)) {
      const target = resolveRefTarget(ref, document.relativePath, registry);
      if (!target || ownership.ownerOf(target) !== SHARED) continue;
      if (!consumers.has(target)) consumers.set(target, new Set());
      consumers.get(target).add(fromOwner);
    }
  }
  return [...consumers.entries()]
    .filter(([, owners]) => owners.size === 1)
    .map(([file, owners]) => ({ file, owner: [...owners][0] }))
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.file.localeCompare(b.file));
}

function buildBaseline(crossings) {
  return {
    $comment:
      'Crossings recorded by scripts/lint-schema-ownership.cjs. This list only shrinks: fix a crossing, then delete its entry. A new entry needs reviewer sign-off in the PR that adds it.',
    entries: crossings.map(({ from, to, rule }) => ({ from, to, rule })),
  };
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const schemasDir = path.resolve(readArg(args, '--schemas', DEFAULT_SCHEMAS_DIR));
  const ownershipPath = path.resolve(readArg(args, '--ownership', DEFAULT_OWNERSHIP_PATH));
  const baselinePath = path.resolve(readArg(args, '--baseline', DEFAULT_BASELINE_PATH));

  if (args.includes('--update-baseline')) {
    if (process.env.ADCP_UPDATE_SCHEMA_OWNERSHIP_BASELINE !== '1') {
      console.error('Refusing to update the baseline without ADCP_UPDATE_SCHEMA_OWNERSHIP_BASELINE=1.');
      process.exitCode = 2;
      return;
    }
    const result = lintSchemaOwnership({ schemasDir, ownershipPath, baselineValue: { entries: [] } });
    const blocking = result.errors.filter((error) => !error.startsWith('new '));
    if (blocking.length > 0) {
      console.error(blocking.join('\n'));
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(buildBaseline(result.crossings), null, 2)}\n`);
    console.log(`Wrote ${result.crossings.length} crossings to ${toPosix(path.relative(REPO_ROOT, baselinePath))}.`);
    return;
  }

  const result = lintSchemaOwnership({ schemasDir, ownershipPath, baselinePath });

  if (args.includes('--suggest') && result.ownership && result.registry) {
    const suggestions = suggestOwners(result.registry, result.ownership);
    console.log(`${suggestions.length} shared files have exactly one consuming domain:`);
    for (const { file, owner } of suggestions) console.log(`  ${owner.padEnd(24)} ${file}`);
    return;
  }

  if (result.ok) {
    const byRule = (rule) => result.crossings.filter((crossing) => crossing.rule === rule).length;
    console.log(
      `✓ schema ownership lint: ${result.files} files, ${result.crossFileRefs} cross-file refs, ` +
      `${result.crossings.length} recorded crossings (${byRule('shared-to-domain')} shared → domain, ` +
      `${byRule('undeclared-domain-dependency')} undeclared domain dependencies), 0 new`,
    );
    return;
  }

  console.error(`✗ schema ownership lint failed with ${result.errors.length} error(s):\n`);
  result.errors.forEach((error) => console.error(`  - ${error}`));
  if ((result.added || []).length > 0) {
    console.error(
      '\nFor each new crossing, prefer in order: move the shared vocabulary into core/ or enums/;' +
      ' declare the dependency in scripts/schema-ownership.json (may_depend_on) when one domain' +
      ' legitimately builds on another; or record it in the baseline with reviewer sign-off' +
      ' (ADCP_UPDATE_SCHEMA_OWNERSHIP_BASELINE=1 node scripts/lint-schema-ownership.cjs --update-baseline).',
    );
  }
  process.exitCode = 1;
}

module.exports = {
  SHARED,
  buildBaseline,
  buildOwnership,
  classifyEdge,
  collectCrossings,
  collectRefs,
  findCycle,
  lintSchemaOwnership,
  loadSchemaRegistry,
  resolveRefTarget,
  suggestOwners,
  validateBaseline,
};

if (require.main === module) main();
