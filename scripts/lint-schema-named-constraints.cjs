#!/usr/bin/env node
/**
 * Keeps scalar constraints named (#8525).
 *
 * A named schema is a scalar with a pattern, an enum, or bounds that has a
 * name: the root of a document, or an entry under `definitions` or `$defs`. A
 * document root is named for the whole tree; a local definition is named for
 * its own document. The lint fails when:
 *
 *   - an inline subschema states a named schema's constraints instead of
 *     referencing it. The message gives the file, the JSON pointer, and the
 *     $ref to use;
 *   - the same unnamed constraint repeats at 2 or more sites, in one document
 *     or across documents. A weak string constraint must also repeat on the
 *     same property name;
 *   - a document that another document composes uses a local definition, which
 *     only resolves inside its own document.
 *
 * How constraints compare. Annotations don't count, enum values compare as a
 * set, equivalent pattern spellings compare equal, and a `type` that the constraint already implies doesn't count either:
 * an enum whose values all have that type, or a key under `propertyNames`,
 * which is always a string. A constraint is strong when it has a pattern, an
 * enum, or a numeric range with both ends: equality alone is evidence. It is
 * weak when it only bounds a length or one numeric end, such as `minLength: 1`,
 * which free text and dozens of identifiers share. A weak constraint counts as
 * a copy only when the site also has the named schema's x-entity, or the name
 * of a property that already references that schema, and it counts toward a
 * repeat only on one string property name. Unbounded strings and format-only
 * strings are not constraints here, because `format` already names the value.
 * Sites inside `if` and `not` are conditions, not declarations, so the lint
 * skips them.
 *
 * Composed documents. A validator resolves `#/definitions/...` against the
 * document that holds it, whoever references that document. Code generators
 * resolve it against the document they are generating when they flatten a
 * referenced document into it, and they don't bring its definitions along. That
 * happens at three kinds of site, so what they reference, a whole document or
 * the subschema a fragment names, must not use a local reference there:
 *
 *   - a `$ref` in `allOf` beside `properties` or `required`, for each of the
 *     target's properties that the site doesn't state itself;
 *   - a `$ref` on a property that an enclosing schema also declares, reached
 *     through `allOf`, `anyOf`, or `oneOf`;
 *   - a `$ref` with schema keywords beside it.
 *
 * Any other reference stays a reference, and resolves in its own document, so
 * it can use local definitions freely.
 *
 * There are no exceptions. A site that means the same thing references the
 * named schema. A site that means something else gets a named schema of its own.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const MIN_REPEAT_SITES = 2;

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
const COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf'];
const DEFINITION_POINTER = /\/(definitions|\$defs)\/[^/]+$/;

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

/**
 * Every schema position in the tree except conditions. `isKey` marks a
 * position under `propertyNames`, which only ever validates a string key.
 */
function collectSites(documents) {
  const sites = [];
  function visit(node, file, pointer, property, isKey) {
    if (!isObject(node)) return;
    sites.push({ file, pointer, node, property, isKey });
    for (const key of SCHEMA_MAP_KEYS) {
      if (!isObject(node[key])) continue;
      for (const [name, child] of Object.entries(node[key])) {
        visit(child, file, `${pointer}/${key}/${escapePointer(name)}`, key === 'properties' ? name : null, false);
      }
    }
    for (const key of SCHEMA_SINGLE_KEYS) {
      if (isObject(node[key])) {
        visit(node[key], file, `${pointer}/${key}`, key === 'items' ? property : null, isKey || key === 'propertyNames');
      }
    }
    for (const key of SCHEMA_ARRAY_KEYS) {
      if (Array.isArray(node[key])) {
        node[key].forEach((child, index) => visit(child, file, `${pointer}/${key}/${index}`, property, isKey));
      }
    }
  }
  for (const document of documents) visit(document.schema, document.file, '', null, false);
  return sites;
}

/**
 * A pattern spelled so that equivalent ECMA-262 spellings compare equal:
 * `\d` outside a character class becomes `[0-9]`, and the members of a simple
 * character class (no negation, no escapes) are sorted, because a class is a
 * set. Other text stays as written.
 */
function normalizePattern(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      if (pattern[i + 1] === 'd') out += '[0-9]';
      else out += c + pattern[i + 1];
      i++;
      continue;
    }
    if (c !== '[') {
      out += c;
      continue;
    }
    let j = i + 1;
    let body = '';
    let simple = pattern[j] !== '^';
    while (j < pattern.length && pattern[j] !== ']') {
      if (pattern[j] === '\\') {
        simple = false;
        body += pattern[j] + pattern[j + 1];
        j += 2;
        continue;
      }
      body += pattern[j];
      j++;
    }
    if (simple) {
      const members = [];
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && k + 2 < body.length) {
          members.push(body.slice(k, k + 3));
          k += 2;
        } else members.push(body[k]);
      }
      // A literal - goes last and a literal ^ never first, so the sorted text
      // reads as the same set and never as a range or a negation.
      const plain = members.filter((m) => m !== '-' && m !== '^').sort();
      body = [...plain, ...members.filter((m) => m === '^'), ...members.filter((m) => m === '-')].join('');
      if (body.startsWith('^')) body = members.join('');
    }
    out += `[${body}]`;
    i = j;
  }
  return out;
}

const ENUM_VALUE_TYPE = (value) => {
  if (typeof value === 'string') return 'string';
  if (Number.isInteger(value)) return 'integer';
  return typeof value === 'number' ? 'number' : null;
};

/**
 * The scalar constraints a node states, or null when it is not a pure scalar.
 * A missing `type` that the constraint implies is filled in, so the typed and
 * untyped spellings of one constraint compare equal.
 */
function constraintsOf(node, isKey = false) {
  if (typeof node.$ref === 'string') return null;
  const constraints = {};
  for (const [key, value] of Object.entries(node)) {
    if (isAnnotation(key)) continue;
    if (!CONSTRAINT_KEYS.has(key)) return null;
    if (key === 'enum') constraints[key] = [...value].map((item) => JSON.stringify(item)).sort();
    else if (key === 'pattern' && typeof value === 'string') constraints[key] = normalizePattern(value);
    else constraints[key] = value;
  }
  if (constraints.type === undefined) {
    const enumTypes = Array.isArray(node.enum) ? new Set(node.enum.map(ENUM_VALUE_TYPE)) : null;
    if (enumTypes && enumTypes.size === 1 && [...enumTypes][0] !== null) constraints.type = [...enumTypes][0];
    else if (isKey) constraints.type = 'string';
  }
  if (!SCALAR_TYPES.has(constraints.type)) {
    // A pattern or enum with no implied type is still a constraint to compare.
    if (constraints.type !== undefined || (constraints.pattern === undefined && constraints.enum === undefined)) return null;
  }
  return constraints;
}

const fingerprint = (constraints) => JSON.stringify(
  Object.fromEntries(Object.keys(constraints).sort().map((key) => [key, constraints[key]])),
);

function strengthOf(constraints) {
  if (constraints.pattern !== undefined) return 'strong';
  if (Array.isArray(constraints.enum) && constraints.enum.length > 0) return 'strong';
  const low = constraints.minimum !== undefined || constraints.exclusiveMinimum !== undefined;
  const high = constraints.maximum !== undefined || constraints.exclusiveMaximum !== undefined;
  if (low && high) return 'strong';
  if (low || high || constraints.minLength !== undefined || constraints.maxLength !== undefined) return 'weak';
  return 'none';
}

/**
 * Named scalar schemas by constraint fingerprint: document roots, and local
 * definitions, which only their own document can reference.
 */
function indexNamedSchemas(documents, sites) {
  const named = new Map();
  const byRef = new Map();
  const add = (entry, constraints) => {
    const key = fingerprint(constraints);
    if (!named.has(key)) named.set(key, []);
    named.get(key).push(entry);
    byRef.set(entry.local ? `${entry.file}#${entry.pointer}` : entry.ref, entry);
  };
  for (const { file, schema } of documents) {
    const constraints = constraintsOf(schema);
    if (!constraints || strengthOf(constraints) === 'none') continue;
    add({
      file,
      pointer: '',
      ref: `/schemas/${file}`,
      local: false,
      constraintKeys: Object.keys(constraints),
      xEntity: schema['x-entity'] || null,
      properties: new Set(),
    }, constraints);
  }
  for (const site of sites) {
    if (!DEFINITION_POINTER.test(site.pointer)) continue;
    const constraints = constraintsOf(site.node, site.isKey);
    if (!constraints || strengthOf(constraints) === 'none') continue;
    add({
      file: site.file,
      pointer: site.pointer,
      ref: `#${site.pointer}`,
      local: true,
      constraintKeys: Object.keys(constraints),
      xEntity: site.node['x-entity'] || null,
      properties: new Set(),
    }, constraints);
  }
  for (const site of sites) {
    const ref = site.node.$ref;
    if (typeof ref !== 'string' || !site.property) continue;
    const entry = byRef.get(ref.startsWith('#') ? `${site.file}${ref}` : ref);
    if (entry) entry.properties.add(site.property);
  }
  return named;
}

/** The named schemas a site copies, narrowed by x-entity and then property name. */
function targetsFor(site, candidates, strength) {
  const reachable = candidates.filter((doc) => !doc.local || (doc.file === site.file && doc.pointer !== site.pointer));
  const siteEntity = site.node['x-entity'] || null;
  // A different x-entity states a different concept, whatever the constraints.
  const compatible = reachable.filter((doc) => !doc.xEntity || !siteEntity || doc.xEntity === siteEntity);
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
    const constraints = constraintsOf(site.node, site.isKey);
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

/** Sites that state the same unnamed constraint, by group. */
function findRepeats(sites, excluded) {
  const groups = new Map();
  for (const site of sites) {
    if (site.pointer === '' || excluded.has(siteKey(site))) continue;
    const constraints = constraintsOf(site.node, site.isKey);
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

/** The first local reference anywhere under a schema node, or null. */
function firstLocalRef(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = firstLocalRef(item);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(node)) return null;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#')) return node.$ref;
  return firstLocalRef(Object.values(node));
}

/** Properties that a branch states and an enclosing schema also declares. */
function refinedProperties(schema, inherited, pointer) {
  const declared = new Set([...inherited, ...Object.keys(isObject(schema.properties) ? schema.properties : {})]);
  const refined = [];
  for (const key of COMPOSITION_KEYS) {
    if (!Array.isArray(schema[key])) continue;
    schema[key].forEach((branch, index) => {
      if (!isObject(branch)) return;
      const branchPointer = `${pointer}/${key}/${index}`;
      for (const [name, property] of Object.entries(isObject(branch.properties) ? branch.properties : {})) {
        if (declared.has(name) && isObject(property)) {
          refined.push({ pointer: `${branchPointer}/properties/${escapePointer(name)}`, node: property });
        }
      }
      refined.push(...refinedProperties(branch, declared, branchPointer));
    });
  }
  return refined;
}

/** References whose target's local references would dangle where the target gets flattened. */
function findComposedLocalRefs(documents, sites) {
  const byRef = new Map(documents.map((document) => [`/schemas/${document.file}`, document]));
  // A whole document, or the subschema a fragment names, with the file that holds it.
  const targetOf = (ref) => {
    if (typeof ref !== 'string') return null;
    const [documentRef, fragment] = ref.split('#');
    const document = byRef.get(documentRef);
    if (!document) return null;
    const schema = (fragment || '').split('/').slice(1)
      .reduce((node, raw) => node?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')], document.schema);
    return isObject(schema) ? { file: document.file, schema } : null;
  };
  const findings = new Map();
  const report = (file, pointer, target, localRef, how) => {
    findings.set(`${file}#${pointer}`, { key: `${file}#${pointer}`, target: target.file, localRef, how });
  };
  for (const { file, pointer, node } of sites) {
    if (Array.isArray(node.allOf) && (isObject(node.properties) || Array.isArray(node.required))) {
      const stated = isObject(node.properties) ? node.properties : {};
      node.allOf.forEach((member, index) => {
        const target = isObject(member) ? targetOf(member.$ref) : null;
        if (!target || target.file === file || !isObject(target.schema.properties)) return;
        const unstated = Object.entries(target.schema.properties).filter(([name]) => !(name in stated));
        const localRef = firstLocalRef(unstated.map(([, property]) => property));
        if (localRef) report(file, `${pointer}/allOf/${index}`, target, localRef, 'in allOf beside properties or required');
      });
    }
    for (const { pointer: refined, node: property } of refinedProperties(node, new Set(), pointer)) {
      const target = targetOf(property.$ref);
      if (!target || target.file === file) continue;
      const localRef = firstLocalRef(target.schema);
      if (localRef) report(file, refined, target, localRef, 'on a property that an enclosing schema also declares');
    }
    const target = targetOf(node.$ref);
    if (target && target.file !== file && Object.keys(node).some((key) => key !== '$ref' && !isAnnotation(key))) {
      const localRef = firstLocalRef(target.schema);
      if (localRef) report(file, pointer, target, localRef, 'with schema keywords beside it');
    }
  }
  return [...findings.values()];
}

const groupLabel = (group) => `${JSON.stringify(group.constraints)}${group.property ? ` on ${group.property}` : ''}`;

/** Holds the tree to the named schemas. Nothing opts a site out. */
function checkTree(documents) {
  const errors = [];
  const sites = collectSites(documents);
  const named = indexNamedSchemas(documents, sites);
  const copies = findInlineCopies(sites, named);
  const copyKeys = new Set(copies.map(({ site }) => siteKey(site)));

  for (const { site, targets } of copies) {
    const key = siteKey(site);
    const refs = targets.map((doc) => doc.ref);
    const removed = targets.length === 1
      ? [...targets[0].constraintKeys, ...(targets[0].xEntity ? ['x-entity'] : [])].filter((k) => k in site.node)
      : Object.keys(site.node).filter((k) => !isAnnotation(k));
    errors.push([
      `${key}: inline copy of a named schema.`,
      targets.length === 1
        ? `  Fix: replace ${removed.map((k) => `"${k}"`).join(', ')} with "$ref": "${refs[0]}" and keep the site's description and other annotations.`
        : `  Fix: replace ${removed.map((k) => `"${k}"`).join(', ')} with a "$ref" to the schema that means the same thing: ${refs.join(', ')}. Or name a new schema if none does.`,
      '  If it means something else, name it with a titled document of its own under core/ or enums/ and reference that.',
    ].join('\n'));
  }

  const groups = findRepeats(sites, copyKeys);
  for (const group of groups.values()) {
    if (group.sites.length < MIN_REPEAT_SITES) continue;
    const files = new Set(group.sites.map((site) => site.file));
    const where = files.size === 1
      ? `a definitions entry in ${[...files][0]}`
      : 'a titled document under core/ or enums/';
    errors.push([
      `Repeated unnamed constraint ${groupLabel(group)} at ${group.sites.length} sites:`,
      ...group.sites.map((site) => `    ${siteKey(site)}`),
      `  Fix: name it with ${where}, then run npm run schemas:normalize -- --doc <its file or file#pointer> --write.`,
      '  If the sites mean different things, give each one a titled document of its own under core/ or enums/.',
    ].join('\n'));
  }

  for (const { key, target, localRef, how } of findComposedLocalRefs(documents, sites)) {
    errors.push([
      `${key}: references ${target} ${how}, and ${target} uses the local reference ${localRef}.`,
      '  Code generators flatten a document composed this way into the one that references it, where the local reference does not resolve.',
      `  Fix: move that definition to a titled document under core/ or enums/, and reference it from ${target}.`,
    ].join('\n'));
  }

  return { errors, copies, groups };
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const schemasDir = path.resolve(readArg(args, '--schemas-dir', DEFAULT_SCHEMAS_DIR));
  const { errors } = checkTree(loadDocuments(schemasDir));
  if (errors.length > 0) {
    console.error(`Schema named-constraints lint: ${errors.length} problem(s)\n\n${errors.join('\n\n')}`);
    process.exit(1);
  }
  console.log('✓ schema named-constraints lint: no inline copies, no repeated constraints, no exceptions');
}

if (require.main === module) main();

module.exports = {
  checkTree,
  collectSites,
  constraintsOf,
  findComposedLocalRefs,
  findInlineCopies,
  findRepeats,
  indexNamedSchemas,
  loadDocuments,
  normalizePattern,
  siteKey,
  strengthOf,
};
