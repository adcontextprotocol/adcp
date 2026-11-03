#!/usr/bin/env node
/**
 * Keeps scalar constraints named (#8525).
 *
 * A named schema is a document whose root is a scalar: a string, number, or
 * integer with a pattern, an enum, a format, or bounds. The lint fails when:
 *
 *   - an inline subschema states a named schema's constraints instead of
 *     referencing it. The message gives the file, the JSON pointer, and the
 *     $ref to use;
 *   - the same unnamed constraint repeats at min_repeat_sites or more sites
 *     across two or more documents. A weak string constraint must also repeat
 *     on the same property name;
 *   - scripts/schema-named-constraints.json is malformed, lists a site or a
 *     repeat that no longer occurs, or has grown against its base copy.
 *
 * How constraints compare. Annotations don't count, and enum values compare as
 * a set. A constraint is strong when it has a pattern, an enum, or a numeric
 * range with both ends: equality alone is evidence. It is weak when it only
 * bounds a length or one numeric end, such as `minLength: 1`, which free text
 * and dozens of identifiers share. A weak constraint counts as a copy only when
 * the site also has the named schema's x-entity, or the name of a property that
 * already references that schema. Unbounded strings and format-only strings are
 * not constraints here, because `format` already names the value. Sites inside
 * `if` and `not` are conditions, not declarations, so the lint skips them.
 *
 * Shrink-only. scripts/schema-named-constraints.json holds the exceptions. An
 * entry that stops occurring fails, so the list shrinks as sites get fixed.
 * With --base-ref (or $ADCP_NAMED_CONSTRAINTS_BASE_REF), the lint also compares
 * the list with that ref's copy: a raised threshold fails, and a repeat count
 * that grew fails unless the entry states a growth_reason. New entries are
 * printed, so a reviewer sees each addition and its reason.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const DEFAULT_LIST_PATH = path.join(REPO_ROOT, 'scripts', 'schema-named-constraints.json');
const LIST_PATH_IN_REPO = 'scripts/schema-named-constraints.json';
const BASE_REF_ENV = 'ADCP_NAMED_CONSTRAINTS_BASE_REF';

const SCALAR_TYPES = new Set(['string', 'number', 'integer']);
const CONSTRAINT_KEYS = new Set([
  'type', 'pattern', 'format', 'enum', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);
const ANNOTATION_KEYS = new Set([
  '$id', '$schema', '$comment', 'title', 'description', 'examples', 'example',
  'default', 'deprecated', 'readOnly', 'writeOnly', 'enumDescriptions', 'enumMetadata',
]);

// Where subschemas sit, so the walk visits schemas and never instance data.
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas', 'dependencies'];
const SCHEMA_SINGLE_KEYS = [
  'additionalItems', 'additionalProperties', 'contains', 'else', 'items',
  'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
];
const SCHEMA_ARRAY_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAnnotation = (key) => ANNOTATION_KEYS.has(key) || key.startsWith('x-');
const escapePointer = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
const siteKey = (site) => `${site.file}#${site.pointer}`;

function loadDocuments(schemasDir) {
  const documents = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'bundled' && entry.name !== 'mcp') walk(full);
      } else if (entry.name.endsWith('.json')) {
        documents.push({
          file: path.relative(schemasDir, full).split(path.sep).join('/'),
          schema: JSON.parse(fs.readFileSync(full, 'utf8')),
        });
      }
    }
  })(schemasDir);
  return documents.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** Every schema position in the tree except conditions. */
function collectSites(documents) {
  const sites = [];
  function visit(node, file, pointer, property) {
    if (!isObject(node)) return;
    sites.push({ file, pointer, node, property });
    for (const key of SCHEMA_MAP_KEYS) {
      if (!isObject(node[key])) continue;
      for (const [name, child] of Object.entries(node[key])) {
        visit(child, file, `${pointer}/${key}/${escapePointer(name)}`, key === 'properties' ? name : null);
      }
    }
    for (const key of SCHEMA_SINGLE_KEYS) {
      if (isObject(node[key])) visit(node[key], file, `${pointer}/${key}`, key === 'items' ? property : null);
    }
    for (const key of SCHEMA_ARRAY_KEYS) {
      if (Array.isArray(node[key])) {
        node[key].forEach((child, index) => visit(child, file, `${pointer}/${key}/${index}`, property));
      }
    }
  }
  for (const document of documents) visit(document.schema, document.file, '', null);
  return sites;
}

/** The scalar constraints a node states, or null when it is not a pure scalar. */
function constraintsOf(node) {
  if (typeof node.$ref === 'string' || !SCALAR_TYPES.has(node.type)) return null;
  const constraints = {};
  for (const [key, value] of Object.entries(node)) {
    if (isAnnotation(key)) continue;
    if (!CONSTRAINT_KEYS.has(key)) return null;
    constraints[key] = key === 'enum' ? [...value].map(String).sort() : value;
  }
  return constraints;
}

const fingerprint = (constraints) => JSON.stringify(
  Object.fromEntries(Object.keys(constraints).sort().map((key) => [key, constraints[key]])),
);

function strengthOf(constraints) {
  if (constraints.pattern !== undefined) return 'strong';
  if (Array.isArray(constraints.enum) && constraints.enum.length > 1) return 'strong';
  const low = constraints.minimum !== undefined || constraints.exclusiveMinimum !== undefined;
  const high = constraints.maximum !== undefined || constraints.exclusiveMaximum !== undefined;
  if (low && high) return 'strong';
  if (low || high || constraints.minLength !== undefined || constraints.maxLength !== undefined) return 'weak';
  return 'none';
}

/** Named scalar documents by constraint fingerprint. */
function indexNamedSchemas(documents, sites) {
  const named = new Map();
  const byRef = new Map();
  for (const { file, schema } of documents) {
    const constraints = constraintsOf(schema);
    if (!constraints || strengthOf(constraints) === 'none') continue;
    const entry = {
      file,
      ref: `/schemas/${file}`,
      constraintKeys: Object.keys(constraints),
      xEntity: schema['x-entity'] || null,
      properties: new Set(),
    };
    const key = fingerprint(constraints);
    if (!named.has(key)) named.set(key, []);
    named.get(key).push(entry);
    byRef.set(entry.ref, entry);
  }
  for (const site of sites) {
    if (typeof site.node.$ref === 'string' && byRef.has(site.node.$ref) && site.property) {
      byRef.get(site.node.$ref).properties.add(site.property);
    }
  }
  return named;
}

/** The named schemas a site copies, narrowed by x-entity and then property name. */
function targetsFor(site, candidates, strength) {
  const siteEntity = site.node['x-entity'] || null;
  // A different x-entity states a different concept, whatever the constraints.
  const compatible = candidates.filter((doc) => !doc.xEntity || !siteEntity || doc.xEntity === siteEntity);
  const byEntity = compatible.filter((doc) => doc.xEntity && doc.xEntity === siteEntity);
  if (byEntity.length > 0) return byEntity;
  const byName = compatible.filter((doc) => site.property && doc.properties.has(site.property));
  if (byName.length > 0) return byName;
  return strength === 'strong' ? compatible : [];
}

/** Sites that state a named schema's constraints inline. */
function findInlineCopies(sites, named) {
  const copies = [];
  for (const site of sites) {
    if (site.pointer === '') continue;
    const constraints = constraintsOf(site.node);
    if (!constraints) continue;
    const strength = strengthOf(constraints);
    if (strength === 'none') continue;
    const candidates = named.get(fingerprint(constraints));
    if (!candidates) continue;
    const targets = targetsFor(site, candidates, strength);
    if (targets.length > 0) copies.push({ site, targets });
  }
  return copies;
}

/** Unnamed constraints by group, excluding sites already reported or held apart. */
function findRepeats(sites, excluded) {
  const groups = new Map();
  for (const site of sites) {
    if (site.pointer === '' || excluded.has(siteKey(site))) continue;
    const constraints = constraintsOf(site.node);
    if (!constraints) continue;
    const strength = strengthOf(constraints);
    if (strength === 'none') continue;
    // A weak constraint alone proves nothing, so its property name must repeat
    // too. A one-sided numeric bound on a repeated name is a measure, not a
    // named value, so it doesn't count.
    if (strength === 'weak' && (!site.property || constraints.type !== 'string')) continue;
    const property = strength === 'weak' ? site.property : null;
    const key = JSON.stringify([fingerprint(constraints), property]);
    if (!groups.has(key)) groups.set(key, { constraints, property, sites: [] });
    groups.get(key).sites.push(site);
  }
  return groups;
}

const repeatKey = (entry) => JSON.stringify([fingerprint(normalizeEntryConstraints(entry.constraint)), entry.property || null]);

function normalizeEntryConstraints(constraint) {
  const out = { ...constraint };
  if (Array.isArray(out.enum)) out.enum = [...out.enum].map(String).sort();
  return out;
}

/** The list's own structure: every entry states its reason. */
function checkList(list) {
  const errors = [];
  if (!Number.isInteger(list.min_repeat_sites) || list.min_repeat_sites < 2) {
    errors.push('min_repeat_sites must be an integer of at least 2');
  }
  const seen = new Set();
  for (const entry of Array.isArray(list.held_apart) ? list.held_apart : []) {
    if (typeof entry.path !== 'string' || !entry.path.includes('#')) {
      errors.push(`held_apart entry ${JSON.stringify(entry)}: path must be file#pointer`);
      continue;
    }
    if (seen.has(entry.path)) errors.push(`held_apart: ${entry.path} is listed twice`);
    seen.add(entry.path);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      errors.push(`held_apart: ${entry.path} has no reason; state why this site is not the named schema`);
    }
  }
  for (const entry of Array.isArray(list.unnamed_repeats) ? list.unnamed_repeats : []) {
    const label = JSON.stringify(entry.constraint);
    if (!isObject(entry.constraint)) errors.push(`unnamed_repeats entry ${JSON.stringify(entry)}: state its constraint`);
    if (!Number.isInteger(entry.sites)) errors.push(`unnamed_repeats ${label}: sites must be the current count`);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      errors.push(`unnamed_repeats ${label}: has no reason; state why it stays unnamed`);
    }
  }
  return errors;
}

/** Holds the tree to the named schemas and the checked-in exceptions. */
function checkTree(documents, list) {
  const errors = checkList(list);
  const sites = collectSites(documents);
  const named = indexNamedSchemas(documents, sites);
  const copies = findInlineCopies(sites, named);
  const held = new Set((list.held_apart || []).map((entry) => entry.path));
  const copyKeys = new Set(copies.map(({ site }) => siteKey(site)));

  for (const { site, targets } of copies) {
    const key = siteKey(site);
    if (held.has(key)) continue;
    const refs = targets.map((doc) => doc.ref);
    const removed = targets.length === 1
      ? [...targets[0].constraintKeys, ...(targets[0].xEntity ? ['x-entity'] : [])]
      : Object.keys(constraintsOf(site.node));
    errors.push([
      `${key}: inline copy of a named schema.`,
      targets.length === 1
        ? `  Fix: replace ${removed.map((k) => `"${k}"`).join(', ')} with "$ref": "${refs[0]}" and keep the site's description and other annotations.`
        : `  Fix: replace ${removed.map((k) => `"${k}"`).join(', ')} with a "$ref" to the schema that means the same thing: ${refs.join(', ')}. Or name a new schema if none does.`,
      `  If it means something else, add {"path": "${key}", "reason": "..."} to held_apart in ${LIST_PATH_IN_REPO}.`,
    ].join('\n'));
  }
  for (const key of held) {
    if (!copyKeys.has(key)) {
      errors.push(`stale held_apart: ${key} is no longer an inline copy of a named schema; remove it from ${LIST_PATH_IN_REPO}`);
    }
  }

  const groups = findRepeats(sites, copyKeys);
  const recorded = new Map((list.unnamed_repeats || []).filter((e) => isObject(e.constraint)).map((entry) => [repeatKey(entry), entry]));
  const threshold = list.min_repeat_sites;
  for (const [key, group] of groups) {
    const count = group.sites.length;
    const documentCount = new Set(group.sites.map((site) => site.file)).size;
    const entry = recorded.get(key);
    if (entry) {
      recorded.delete(key);
      if (count > entry.sites) {
        errors.push(`${JSON.stringify(group.constraints)}${group.property ? ` on ${group.property}` : ''} grew from ${entry.sites} to ${count} sites. Name it, or update the count in unnamed_repeats with a growth_reason.\n  Sites:\n    ${group.sites.map(siteKey).join('\n    ')}`);
      } else if (count < entry.sites) {
        errors.push(`stale unnamed_repeats: ${JSON.stringify(group.constraints)}${group.property ? ` on ${group.property}` : ''} now has ${count} sites, not ${entry.sites}; lower the count or remove the entry`);
      }
      continue;
    }
    if (count >= threshold && documentCount >= 2) {
      errors.push([
        `Repeated unnamed constraint ${JSON.stringify(group.constraints)}${group.property ? ` on ${group.property}` : ''} at ${count} sites:`,
        ...group.sites.map((site) => `    ${siteKey(site)}`),
        '  Fix: add a titled document under core/ or enums/, then run npm run schemas:normalize -- --write.',
        `  If the sites mean different things, add the constraint with its count and a reason to unnamed_repeats in ${LIST_PATH_IN_REPO}.`,
      ].join('\n'));
    }
  }
  for (const entry of recorded.values()) {
    errors.push(`stale unnamed_repeats: ${JSON.stringify(entry.constraint)}${entry.property ? ` on ${entry.property}` : ''} no longer occurs; remove it from ${LIST_PATH_IN_REPO}`);
  }
  return { errors, copies, groups };
}

/** Compares the list with its copy on the base ref. Returns errors and the additions to show. */
function compareToBase(base, head) {
  const errors = [];
  const additions = [];
  if (head.min_repeat_sites > base.min_repeat_sites) {
    errors.push(`min_repeat_sites rose from ${base.min_repeat_sites} to ${head.min_repeat_sites}; the threshold may only fall`);
  }
  const baseHeld = new Set((base.held_apart || []).map((entry) => entry.path));
  for (const entry of head.held_apart || []) {
    if (!baseHeld.has(entry.path)) additions.push(`held_apart ${entry.path}: ${entry.reason}`);
  }
  const baseRepeats = new Map((base.unnamed_repeats || []).map((entry) => [repeatKey(entry), entry]));
  for (const entry of head.unnamed_repeats || []) {
    const previous = baseRepeats.get(repeatKey(entry));
    const label = `${JSON.stringify(entry.constraint)}${entry.property ? ` on ${entry.property}` : ''}`;
    if (!previous) {
      additions.push(`unnamed_repeats ${label}: ${entry.reason}`);
    } else if (entry.sites > previous.sites) {
      if (typeof entry.growth_reason === 'string' && entry.growth_reason.trim()) {
        additions.push(`unnamed_repeats ${label} grew from ${previous.sites} to ${entry.sites}: ${entry.growth_reason}`);
      } else {
        errors.push(`unnamed_repeats ${label} grew from ${previous.sites} to ${entry.sites} sites without a growth_reason; the baseline may only shrink`);
      }
    }
  }
  return { errors, additions };
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const schemasDir = path.resolve(readArg(args, '--schemas-dir', DEFAULT_SCHEMAS_DIR));
  const listPath = path.resolve(readArg(args, '--list', DEFAULT_LIST_PATH));
  const baseRef = readArg(args, '--base-ref', process.env[BASE_REF_ENV] || '');
  const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  const { errors, copies } = checkTree(loadDocuments(schemasDir), list);
  if (baseRef) {
    let baseText = null;
    try {
      baseText = execFileSync('git', ['show', `${baseRef}:${LIST_PATH_IN_REPO}`], {
        cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      console.log(`No list at ${baseRef}; skipping the shrink-only check.`);
    }
    if (baseText) {
      const comparison = compareToBase(JSON.parse(baseText), list);
      errors.push(...comparison.errors);
      for (const addition of comparison.additions) console.log(`Added since ${baseRef}: ${addition}`);
    }
  }
  if (errors.length > 0) {
    console.error(`Schema named-constraints lint: ${errors.length} problem(s)\n\n${errors.join('\n\n')}`);
    process.exit(1);
  }
  console.log(`✓ schema named-constraints lint: ${copies.length - (list.held_apart || []).length} unlisted inline copies, ${(list.held_apart || []).length} held apart, ${(list.unnamed_repeats || []).length} recorded unnamed repeats`);
}

if (require.main === module) main();

module.exports = {
  checkList,
  checkTree,
  collectSites,
  compareToBase,
  constraintsOf,
  findInlineCopies,
  indexNamedSchemas,
  loadDocuments,
  siteKey,
  strengthOf,
};
