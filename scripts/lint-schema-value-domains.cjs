#!/usr/bin/env node
/**
 * Value-domain guard for AdCP source schemas.
 *
 * scripts/schema-value-domains.json is the inventory of AdCP's value concepts:
 * money, the task envelopes, identifiers, timestamps, and the other values
 * every domain uses. Each concept states its meaning, its value domain, and
 * exactly one kernel type: the schema every use of the concept should
 * reference, or "unnamed" until a later change names it. A concept with a
 * `match` rule also lists its sources: every place in static/schemas/source
 * that declares the concept inline today instead of referencing its kernel
 * type. Identity concepts are validation classes: each lists the registered
 * entities (`x-entity`, core/x-entity-types.json) whose IDs belong to it.
 *
 * The lint fails when:
 *   - the inventory is malformed: an unknown value domain, a concept with no
 *     single kernel type, a kernel type that is no schema file, two concepts
 *     that share one kernel type, or an entity that two concepts list;
 *   - a kernel type references a domain schema, directly or through other
 *     files (owners come from scripts/schema-ownership.json);
 *   - a listed source no longer declares the concept inline (stale), the tree
 *     declares the concept inline somewhere the inventory doesn't list, or an
 *     inline `x-entity` belongs to no concept;
 *   - a property name carries two meanings (two concepts, or IDs of two
 *     entities) and the inventory doesn't list it as a homonym, or a listed
 *     homonym carries only one meaning (stale);
 *   - an inline schema or a named schema is a structural twin of a kernel
 *     type, or two named schemas are structural twins, unless the inventory
 *     declares them distinct concepts with a reason.
 *
 * Twins that existed when the lint landed are recorded in
 * scripts/lint-schema-value-domains-baseline.json, each with a verdict from a
 * closed set and a reason. The lint fails on a twin that isn't recorded and
 * on a recorded twin that no longer occurs, so the baseline only shrinks.
 *
 * Structural fingerprints drop annotations (titles, descriptions, examples,
 * `x-*` keys), sort set-valued keywords, treat `additionalProperties: true`
 * as the default it is, and resolve each `$ref` to the file it names. A schema
 * that only references another (`$ref`, or an `allOf` of one `$ref`) is an
 * alias, not a re-declaration, so it is no twin. A schema that constrains
 * nothing beyond its `type` (such as core/ext.json) has no structural twins:
 * every free-form object would match it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  buildOwnership,
  loadSchemaRegistry,
  resolveRefTarget,
  SHARED,
} = require('./lint-schema-ownership.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const DEFAULT_INVENTORY_PATH = path.join(REPO_ROOT, 'scripts', 'schema-value-domains.json');
const DEFAULT_OWNERSHIP_PATH = path.join(REPO_ROOT, 'scripts', 'schema-ownership.json');
const DEFAULT_BASELINE_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'lint-schema-value-domains-baseline.json',
);
const ENTITY_REGISTRY = 'core/x-entity-types.json';
const UNNAMED = 'unnamed';
const VERDICTS = new Map([
  ['replace', 'a later change replaces the copy with a $ref to the kernel type'],
  ['merge', 'the schemas mean one thing; a later change keeps one and makes the others reference it'],
  ['alias', 'a deliberate compatibility name, kept until the next major version'],
]);
const MATCH_KINDS = ['properties', 'x-entity', 'format', 'property'];

// Fingerprint vocabulary, ported from the structural duplication check.
const ANNOTATION_KEYS = new Set([
  '$id',
  '$schema',
  '$comment',
  'title',
  'description',
  'examples',
  'example',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'enumDescriptions',
  'enumMetadata',
]);
const SET_KEYS = new Set(['enum', 'required', 'type']);
const NAME_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
]);

// Where subschemas sit, so the walk visits schemas and never instance data.
const SCHEMA_MAP_KEYS = [...NAME_MAP_KEYS, 'dependencies'];
const SCHEMA_SINGLE_KEYS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const SCHEMA_ARRAY_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byString(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort(byString)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function escapePointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * The structure of a schema with annotations removed, set-valued keywords
 * sorted, and each `$ref` resolved to the file it names. Instance data
 * (`const`, `enum` items) is kept as it is.
 */
function normalize(node, file, registry) {
  if (Array.isArray(node)) return node.map((child) => normalize(child, file, registry));
  if (!isObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATION_KEYS.has(key) || key.startsWith('x-')) continue;
    if (key === 'additionalProperties' && value === true) continue;
    if (key === '$ref' && typeof value === 'string') {
      const resolved = resolveRefTarget(value, file, registry);
      const fragment = value.includes('#') ? `#${value.split('#')[1]}` : '';
      out[key] = resolved && resolved.target ? `${resolved.target}${fragment}` : value;
    } else if (key === 'const') {
      out[key] = value;
    } else if (SET_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map(canonicalJson).sort(byString);
    } else if ((NAME_MAP_KEYS.has(key) || key === 'dependencies') && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [
        name,
        Array.isArray(schema) ? [...schema].sort(byString) : normalize(schema, file, registry),
      ]));
    } else {
      out[key] = normalize(value, file, registry);
    }
  }
  return out;
}

function fingerprint(node, file, registry) {
  return canonicalJson(normalize(node, file, registry));
}

/** True when a normalized schema only references another schema. */
function isAlias(normalized) {
  const keys = Object.keys(normalized);
  if (keys.length === 1 && keys[0] === '$ref') return true;
  return keys.length === 1 && keys[0] === 'allOf' && normalized.allOf.length === 1
    && isAlias(normalized.allOf[0]);
}

/** True when a normalized schema constrains nothing beyond its type. */
function isBare(normalized) {
  const keys = Object.keys(normalized);
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'type');
}

/**
 * Every schema position in the tree: each file's root and every subschema
 * under it. `property` is the property name when the site is a declared
 * property (or the items of one).
 */
function collectSites(registry) {
  const sites = [];
  function visit(node, file, pointer, property) {
    if (!isObject(node)) return;
    sites.push({ file, pointer, node, root: pointer === '', property });
    for (const key of SCHEMA_MAP_KEYS) {
      if (!isObject(node[key])) continue;
      for (const [name, child] of Object.entries(node[key])) {
        const childPointer = `${pointer}/${key}/${escapePointer(name)}`;
        visit(child, file, childPointer, key === 'properties' ? name : null);
      }
    }
    for (const key of SCHEMA_SINGLE_KEYS) {
      if (isObject(node[key])) {
        visit(node[key], file, `${pointer}/${key}`, key === 'items' ? property : null);
      }
    }
    for (const key of SCHEMA_ARRAY_KEYS) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((child, index) => visit(child, file, `${pointer}/${key}/${index}`, null));
    }
  }
  for (const document of registry.documents) visit(document.schema, document.relativePath, '', null);
  return sites;
}

function siteKey(site) {
  return `${site.file}#${site.pointer}`;
}

function sameNames(a, b) {
  const sortedB = [...b].sort(byString);
  return a.length === b.length && [...a].sort(byString).every((name, i) => name === sortedB[i]);
}

/**
 * True when the site declares the concept inline: it matches the concept's
 * rule and doesn't merely reference another schema.
 */
function matchesConcept(site, match) {
  const { node } = site;
  if (typeof node.$ref === 'string') return false;
  if (match.properties) {
    if (!isObject(node.properties) || !sameNames(Object.keys(node.properties), match.properties)) {
      return false;
    }
    return Object.entries(match.const || {}).every(([name, value]) =>
      isObject(node.properties[name]) && node.properties[name].const === value);
  }
  if (match['x-entity']) return match['x-entity'].includes(node['x-entity']);
  if (match.format) return node.format === match.format;
  if (match.property) return site.pointer.endsWith(`/properties/${escapePointer(match.property)}`);
  return false;
}

function schemaPathOf(id) {
  return typeof id === 'string' ? id.replace(/^\/schemas\//, '') : null;
}

function readJson(file, label) {
  if (!fs.existsSync(file)) return { error: `missing ${label}: ${file}` };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: `invalid ${label} JSON: ${error.message}` };
  }
}

function loadEntityRegistry(registry) {
  const document = registry.byKey.get(ENTITY_REGISTRY);
  const definitions = document && isObject(document.schema['x-entity-definitions'])
    ? document.schema['x-entity-definitions']
    : {};
  return new Set(Object.keys(definitions));
}

/** Validates the inventory's own structure. Returns the problems and the usable concepts. */
function checkInventory(inventory, registry) {
  const errors = [];
  if (!isObject(inventory)) {
    return { errors: ['inventory must be an object'], concepts: [], kernelOwners: new Map(), entityOwners: new Map() };
  }
  const valueDomains = isObject(inventory.value_domains) ? inventory.value_domains : {};
  if (Object.keys(valueDomains).length === 0) errors.push('value_domains must name at least one value domain');
  const entities = loadEntityRegistry(registry);
  const concepts = [];
  const ids = new Set();
  const kernelOwners = new Map();
  const entityOwners = new Map();
  const list = Array.isArray(inventory.concepts) ? inventory.concepts : [];
  if (!Array.isArray(inventory.concepts)) errors.push('concepts must be an array');
  list.forEach((concept, index) => {
    const label = `concepts[${index}]${concept && concept.id ? ` (${concept.id})` : ''}`;
    if (!isObject(concept) || typeof concept.id !== 'string' || !concept.id) {
      errors.push(`${label}: every concept needs a string id`);
      return;
    }
    if (ids.has(concept.id)) errors.push(`${label}: concept ${concept.id} is defined twice; define each concept once`);
    ids.add(concept.id);
    if (!Object.prototype.hasOwnProperty.call(valueDomains, concept.value_domain)) {
      errors.push(`${label}: value_domain ${concept.value_domain} is not one of: ${Object.keys(valueDomains).join(', ')}`);
    }
    const match = concept.match;
    if (typeof concept.meaning !== 'string' || !concept.meaning.trim()) errors.push(`${label}: state its meaning`);
    const conceptEntities = isObject(match) ? match['x-entity'] : undefined;
    if (conceptEntities !== undefined) {
      if (!Array.isArray(conceptEntities) || conceptEntities.length === 0) {
        errors.push(`${label}: match.x-entity must list one or more registered entities`);
      } else {
        for (const entity of conceptEntities) {
          if (!entities.has(entity)) errors.push(`${label}: x-entity ${entity} is not registered in ${ENTITY_REGISTRY}`);
          else if (entityOwners.has(entity)) errors.push(`${label}: x-entity ${entity} already belongs to ${entityOwners.get(entity)}; each entity has one identity concept`);
          else entityOwners.set(entity, concept.id);
        }
      }
    }
    if (typeof concept.kernel_type !== 'string') {
      errors.push(`${label}: kernel_type must be exactly one schema $id, or "${UNNAMED}"`);
    } else if (concept.kernel_type !== UNNAMED) {
      const target = schemaPathOf(concept.kernel_type);
      if (!registry.byKey.has(target)) {
        errors.push(`${label}: kernel_type ${concept.kernel_type} is no schema file`);
      } else if (kernelOwners.has(target)) {
        errors.push(`${label}: kernel_type ${concept.kernel_type} already represents ${kernelOwners.get(target)}; one type represents one concept`);
      } else {
        kernelOwners.set(target, concept.id);
      }
    }
    if (match !== undefined) {
      const kinds = isObject(match) ? Object.keys(match).filter((key) => key !== 'const') : [];
      if (kinds.length !== 1 || !MATCH_KINDS.includes(kinds[0])) {
        errors.push(`${label}: match must use exactly one of: ${MATCH_KINDS.join(', ')}`);
      }
      if (!Array.isArray(concept.sources)) errors.push(`${label}: a concept with a match rule lists its sources`);
    } else if (concept.sources !== undefined) {
      errors.push(`${label}: sources need a match rule that finds them`);
    }
    concepts.push(concept);
  });
  return { errors, concepts, kernelOwners, entityOwners };
}

/** Files a schema reaches through `$ref`, transitively, excluding itself. */
function closureOf(file, refsOf) {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length > 0) {
    for (const target of refsOf(queue.pop())) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  seen.delete(file);
  return seen;
}

function buildRefIndex(registry, sites) {
  const refs = new Map(registry.documents.map(({ relativePath }) => [relativePath, new Set()]));
  for (const site of sites) {
    if (typeof site.node.$ref !== 'string') continue;
    const resolved = resolveRefTarget(site.node.$ref, site.file, registry);
    if (resolved && resolved.target && resolved.target !== site.file) refs.get(site.file).add(resolved.target);
  }
  return (file) => refs.get(file) || new Set();
}

function checkKernelClosure(kernelOwners, refsOf, ownership) {
  const errors = [];
  for (const [file, concept] of [...kernelOwners].sort(([a], [b]) => byString(a, b))) {
    for (const target of [...closureOf(file, refsOf)].sort(byString)) {
      const owner = ownership.ownerOf(target);
      if (owner && owner !== SHARED) {
        errors.push(`kernel type ${file} (${concept}) references ${target}, a ${owner} schema; a kernel type references only shared schemas`);
      }
    }
  }
  return errors;
}

function checkSources(concepts, sites, entityOwners) {
  const errors = [];
  const sourceOf = new Map();
  const unmapped = new Set();
  for (const site of sites) {
    const entity = site.node['x-entity'];
    if (typeof entity === 'string' && typeof site.node.$ref !== 'string' && !entityOwners.has(entity)) unmapped.add(entity);
  }
  for (const entity of [...unmapped].sort(byString)) {
    errors.push(`unmapped entity: x-entity ${entity} is declared inline, but no concept's match lists it; add it to one identity concept`);
  }
  for (const concept of concepts) {
    if (!isObject(concept.match) || !Array.isArray(concept.sources)) continue;
    const kernelFile = schemaPathOf(concept.kernel_type);
    const found = new Map();
    for (const site of sites) {
      if (site.root && site.file === kernelFile) continue;
      if (!matchesConcept(site, concept.match)) continue;
      // An entity two concepts list is reported once, by the inventory check; its sites stay with the first.
      const entity = site.node['x-entity'];
      if (concept.match['x-entity'] && entityOwners.get(entity) !== concept.id) continue;
      found.set(siteKey(site), site);
    }
    const listed = new Set();
    for (const source of concept.sources) {
      if (listed.has(source)) errors.push(`concept ${concept.id}: source ${source} is listed twice`);
      listed.add(source);
      if (!found.has(source)) {
        errors.push(`stale source: ${source} no longer declares ${concept.id} inline; remove it from the concept`);
      }
    }
    for (const [key, site] of found) {
      if (sourceOf.has(key)) {
        errors.push(`${key} declares both ${sourceOf.get(key).concept} and ${concept.id}; one site carries one concept`);
      } else {
        const meaning = typeof site.node['x-entity'] === 'string' ? `${concept.id}:${site.node['x-entity']}` : concept.id;
        sourceOf.set(key, { concept: concept.id, meaning, property: site.property });
      }
      if (listed.has(key)) continue;
      const fix = concept.kernel_type === UNNAMED
        ? 'list it under the concept\'s sources until the kernel type is named'
        : `reference ${concept.kernel_type} instead`;
      errors.push(`new inline ${concept.id}: ${key} declares the concept inline; ${fix}`);
    }
  }
  return { errors, sourceOf };
}

function checkHomonyms(inventory, sourceOf) {
  const errors = [];
  const conceptsByName = new Map();
  // A meaning is a concept, or for identity concepts the entity an ID names.
  for (const { meaning, property } of sourceOf.values()) {
    if (!property) continue;
    if (!conceptsByName.has(property)) conceptsByName.set(property, new Set());
    conceptsByName.get(property).add(meaning);
  }
  const homonyms = Array.isArray(inventory.homonyms) ? inventory.homonyms : [];
  const listed = new Map();
  homonyms.forEach((entry, index) => {
    const label = `homonyms[${index}]`;
    if (!isObject(entry) || typeof entry.name !== 'string') {
      errors.push(`${label} must name a property`);
      return;
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      errors.push(`${label} (${entry.name}): state the reason the name carries more than one concept`);
    }
    if (listed.has(entry.name)) errors.push(`${label}: homonym ${entry.name} is listed twice`);
    listed.set(entry.name, entry);
  });
  for (const [name, concepts] of [...conceptsByName].sort(([a], [b]) => byString(a, b))) {
    if (concepts.size > 1 && !listed.has(name)) {
      errors.push(`homonym: the property name ${name} carries ${concepts.size} meanings (${[...concepts].sort(byString).join(', ')}); list it under homonyms with the reason`);
    }
  }
  for (const name of listed.keys()) {
    if ((conceptsByName.get(name) || new Set()).size < 2) {
      errors.push(`stale homonym: the property name ${name} carries at most one meaning; remove it from homonyms`);
    }
  }
  return errors;
}

/**
 * Finds every structural twin: kernel-type twins and named-schema twins. A
 * site its concept's match rule already finds is a source, not a twin. A
 * named group that holds a kernel type reports its other members as kernel
 * twins, and is a named twin only among its kernel types.
 */
function findTwins(sites, registry, kernelOwners, inventory, sourceOf) {
  const twins = [];
  const prints = new Map();
  for (const site of sites) {
    const normalized = normalize(site.node, site.file, registry);
    if (isAlias(normalized)) continue;
    prints.set(site, { print: canonicalJson(normalized), bare: isBare(normalized) });
  }
  // Two kernel types may share a structure (declared distinct); a copy is reported against the first.
  const kernelPrints = new Map();
  for (const file of [...kernelOwners.keys()].sort(byString)) {
    const site = sites.find((candidate) => candidate.root && candidate.file === file);
    const entry = site && prints.get(site);
    if (entry && !entry.bare && !kernelPrints.has(entry.print)) kernelPrints.set(entry.print, file);
  }
  const namedGroups = new Map();
  for (const [site, { print }] of prints) {
    const kernelFile = kernelPrints.get(print);
    const source = sourceOf.get(siteKey(site));
    const isSource = source && source.concept === kernelOwners.get(kernelFile);
    if (kernelFile && !isSource && !(site.root && kernelOwners.has(site.file))) {
      twins.push({
        check: 'kernel-twin',
        key: `kernel-twin: ${siteKey(site)} = ${kernelFile}`,
        site: siteKey(site),
        kernel_type: kernelFile,
      });
    }
    if (site.root) {
      if (!namedGroups.has(print)) namedGroups.set(print, []);
      namedGroups.get(print).push(site.file);
    }
  }
  const distinct = Array.isArray(inventory.distinct_structures) ? inventory.distinct_structures : [];
  const declared = new Set(distinct
    .filter((entry) => isObject(entry) && Array.isArray(entry.types))
    .map((entry) => entry.types.map(schemaPathOf).sort(byString).join(' = ')));
  for (const files of namedGroups.values()) {
    const kernels = files.filter((file) => kernelOwners.has(file));
    const members = kernels.length > 0 ? kernels : files;
    if (members.length < 2) continue;
    const types = [...members].sort(byString);
    const key = `named-twin: ${types.join(' = ')}`;
    if (declared.has(types.join(' = '))) continue;
    twins.push({ check: 'named-twin', key, types });
  }
  return { twins: twins.sort((a, b) => byString(a.key, b.key)), namedGroups };
}

function checkDistinct(inventory, registry, namedGroups) {
  const errors = [];
  const distinct = Array.isArray(inventory.distinct_structures) ? inventory.distinct_structures : [];
  const groupOf = new Map();
  for (const files of namedGroups.values()) for (const file of files) groupOf.set(file, files);
  distinct.forEach((entry, index) => {
    const label = `distinct_structures[${index}]`;
    const types = Array.isArray(entry && entry.types) ? entry.types.map(schemaPathOf) : [];
    if (types.length < 2) {
      errors.push(`${label} must list two or more schema $ids`);
      return;
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      errors.push(`${label}: state the reason a receiver treats these schemas differently`);
    }
    const missing = types.filter((file) => !registry.byKey.has(file));
    if (missing.length > 0) {
      errors.push(`${label}: ${missing.join(', ')} is no schema file`);
      return;
    }
    const group = groupOf.get(types[0]) || [];
    const sameGroup = group.length === types.length && types.every((file) => group.includes(file));
    if (!sameGroup) {
      errors.push(`stale distinct structure: ${types.join(', ')} no longer share exactly one structure; remove or correct the entry`);
    }
  });
  return errors;
}

function validateBaseline(value) {
  const errors = [];
  const entries = isObject(value) && Array.isArray(value.entries) ? value.entries : null;
  if (!entries) return { entries: new Map(), errors: ['baseline must contain an entries array'] };
  const byKey = new Map();
  entries.forEach((entry, index) => {
    const label = `baseline entries[${index}]`;
    let key = null;
    if (entry && entry.check === 'kernel-twin' && typeof entry.site === 'string' && typeof entry.kernel_type === 'string') {
      key = `kernel-twin: ${entry.site} = ${entry.kernel_type}`;
    } else if (entry && entry.check === 'named-twin' && Array.isArray(entry.types) && entry.types.length > 1) {
      key = `named-twin: ${[...entry.types].sort(byString).join(' = ')}`;
    } else {
      errors.push(`${label} must be a kernel-twin (site, kernel_type) or a named-twin (types) entry`);
      return;
    }
    if (!VERDICTS.has(entry.verdict)) {
      errors.push(`${label}.verdict must be one of: ${[...VERDICTS.keys()].join(', ')}`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) errors.push(`${label}: state the reason`);
    if (byKey.has(key)) errors.push(`${label} duplicates ${key}`);
    byKey.set(key, entry);
  });
  return { entries: byKey, errors };
}

function lintSchemaValueDomains({
  schemasDir = DEFAULT_SCHEMAS_DIR,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  ownershipPath = DEFAULT_OWNERSHIP_PATH,
  baselinePath = DEFAULT_BASELINE_PATH,
  inventoryValue,
  ownershipValue,
  baselineValue,
} = {}) {
  const errors = [];
  const registry = loadSchemaRegistry(schemasDir);
  errors.push(...registry.parseErrors.map((error) => `schema parse error: ${error}`));

  const read = (value, file, label) => {
    if (value !== undefined) return value;
    const result = readJson(file, label);
    if (result.error) errors.push(result.error);
    return result.value;
  };
  const inventory = read(inventoryValue, inventoryPath, 'value-domain inventory');
  const ownershipConfig = read(ownershipValue, ownershipPath, 'ownership config');
  const baselineRaw = read(baselineValue, baselinePath, 'baseline');
  if (inventory === undefined || ownershipConfig === undefined) return { ok: false, errors };

  const ownership = buildOwnership(ownershipConfig);
  errors.push(...ownership.errors);
  const inventoryCheck = checkInventory(inventory, registry);
  errors.push(...inventoryCheck.errors);
  const { concepts, kernelOwners, entityOwners } = inventoryCheck;

  const sites = collectSites(registry);
  const refsOf = buildRefIndex(registry, sites);
  if (ownership.errors.length === 0) {
    errors.push(...checkKernelClosure(kernelOwners, refsOf, ownership));
  }
  const sources = checkSources(concepts, sites, entityOwners);
  errors.push(...sources.errors);
  errors.push(...checkHomonyms(inventory, sources.sourceOf));

  const { twins, namedGroups } = findTwins(sites, registry, kernelOwners, inventory, sources.sourceOf);
  errors.push(...checkDistinct(inventory, registry, namedGroups));
  const baseline = validateBaseline(baselineRaw);
  errors.push(...baseline.errors);
  const found = new Set(twins.map((twin) => twin.key));
  const added = twins.filter((twin) => !baseline.entries.has(twin.key));
  for (const twin of added) {
    const fix = twin.check === 'kernel-twin'
      ? `reference ${twin.kernel_type} instead`
      : 'make one reference the other, or declare them distinct concepts under distinct_structures with the reason';
    errors.push(`new ${twin.key}; ${fix}`);
  }
  for (const key of baseline.entries.keys()) {
    if (!found.has(key)) errors.push(`stale baseline entry: ${key} no longer occurs; remove it from the baseline`);
  }

  return {
    ok: errors.length === 0,
    errors,
    concepts,
    twins,
    added,
    baseline: [...baseline.entries.values()],
    sourceCount: sources.sourceOf.size,
    registry,
    sites,
  };
}

/** The sources each concept's match rule finds in the tree today. */
function detectSources(inventory, registry, sites = collectSites(registry)) {
  const result = new Map();
  for (const concept of Array.isArray(inventory.concepts) ? inventory.concepts : []) {
    if (!isObject(concept.match)) continue;
    const kernelFile = schemaPathOf(concept.kernel_type);
    result.set(concept.id, sites
      .filter((site) => !(site.root && site.file === kernelFile) && matchesConcept(site, concept.match))
      .map(siteKey)
      .sort(byString));
  }
  return result;
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const schemasDir = path.resolve(readArg(args, '--schemas', DEFAULT_SCHEMAS_DIR));
  const inventoryPath = path.resolve(readArg(args, '--inventory', DEFAULT_INVENTORY_PATH));
  const ownershipPath = path.resolve(readArg(args, '--ownership', DEFAULT_OWNERSHIP_PATH));
  const baselinePath = path.resolve(readArg(args, '--baseline', DEFAULT_BASELINE_PATH));

  if (args.includes('--update-sources')) {
    if (process.env.ADCP_UPDATE_SCHEMA_VALUE_DOMAINS !== '1') {
      console.error('Refusing to rewrite inventory sources without ADCP_UPDATE_SCHEMA_VALUE_DOMAINS=1.');
      process.exitCode = 2;
      return;
    }
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    const detected = detectSources(inventory, loadSchemaRegistry(schemasDir));
    for (const concept of inventory.concepts) {
      if (detected.has(concept.id)) concept.sources = detected.get(concept.id);
    }
    fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    const total = [...detected.values()].reduce((sum, list) => sum + list.length, 0);
    console.log(`Wrote ${total} sources for ${detected.size} concepts to ${path.relative(REPO_ROOT, inventoryPath)}.`);
    return;
  }

  const result = lintSchemaValueDomains({ schemasDir, inventoryPath, ownershipPath, baselinePath });
  if (result.ok) {
    const byCheck = (check) => result.twins.filter((twin) => twin.check === check).length;
    console.log(
      `✓ schema value-domain lint: ${result.concepts.length} concepts, ${result.sourceCount} inline sources, ` +
      `${result.twins.length} recorded twins (${byCheck('kernel-twin')} of kernel types, ` +
      `${byCheck('named-twin')} named), 0 new`,
    );
    return;
  }
  console.error(`✗ schema value-domain lint failed with ${result.errors.length} error(s):\n`);
  result.errors.forEach((error) => console.error(`  - ${error}`));
  process.exitCode = 1;
}

module.exports = {
  UNNAMED,
  VERDICTS,
  collectSites,
  detectSources,
  fingerprint,
  isAlias,
  isBare,
  lintSchemaValueDomains,
  matchesConcept,
  normalize,
};

if (require.main === module) main();
