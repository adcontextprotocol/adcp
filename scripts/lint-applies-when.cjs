#!/usr/bin/env node
/**
 * Guard for the `x-adcp-applies-when` schema annotation.
 *
 * The annotation names the get_adcp_capabilities declarations that make a
 * property relevant, so projections (for example a non-guaranteed-only MCP
 * tool surface) can drop fields a seller never uses. It never changes wire
 * validation, which makes typos silent: a misspelled capability path or enum
 * value would just leave a field unprojected. This lint makes them loud.
 *
 * Rules (docs/reference/schema-extensions.mdx#x-adcp-applies-when):
 *   - the annotation sits on a property declaration (a member of `properties`);
 *   - its value is an object using only the known keys, each a non-empty array
 *     of unique strings;
 *   - delivery_types / pricing_models values are members of their enums;
 *   - every capabilities path resolves to a property declared in
 *     protocol/get-adcp-capabilities-response.json (following $ref);
 *   - an annotated property is not listed in its parent's `required`, because
 *     a projection may only remove optional properties.
 */

'use strict';

const path = require('node:path');

const {
  loadSchemaRegistry,
  resolveRef,
} = require('./lint-language-tag-refs.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const ANNOTATION = 'x-adcp-applies-when';
const CAPABILITIES_RESPONSE = 'protocol/get-adcp-capabilities-response.json';
const ENUM_KEYS = {
  delivery_types: 'enums/delivery-type.json',
  pricing_models: 'enums/pricing-model.json',
};
const KNOWN_KEYS = new Set([...Object.keys(ENUM_KEYS), 'capabilities']);
// Values under these keywords are instance data, not schema declarations.
const NON_SCHEMA_KEYS = new Set(['const', 'default', 'enum', 'examples']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointerToken(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function loadEnum(registry, relativePath, errors) {
  const document = registry.byKey.get(relativePath);
  if (!document || !Array.isArray(document.schema.enum)) {
    errors.push(`missing enum schema: ${relativePath}`);
    return new Set();
  }
  return new Set(document.schema.enum);
}

/** Unconditional `required` names: the parent's own plus allOf arms without `if`. */
function requiredNames(parent) {
  const names = new Set(Array.isArray(parent.required) ? parent.required : []);
  if (Array.isArray(parent.allOf)) {
    for (const arm of parent.allOf) {
      if (isObject(arm) && !('if' in arm) && Array.isArray(arm.required)) {
        arm.required.forEach((name) => names.add(name));
      }
    }
  }
  return names;
}

/**
 * Returns the schemas a property name can resolve to inside `schema`, looking
 * through $ref and allOf/anyOf/oneOf arms.
 */
function findPropertySchemas(schema, document, registry, name, seen = new Set()) {
  if (!isObject(schema)) return [];
  if (typeof schema.$ref === 'string') {
    const marker = `${document.relativePath}:${schema.$ref}`;
    if (seen.has(marker)) return [];
    seen.add(marker);
    const resolved = resolveRef(schema.$ref, document, registry);
    if (!resolved) return [];
    return findPropertySchemas(resolved.node, resolved.document, registry, name, seen);
  }
  const found = [];
  if (isObject(schema.properties) && isObject(schema.properties[name])) {
    found.push({ schema: schema.properties[name], document });
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const arm of schema[keyword]) {
      found.push(...findPropertySchemas(arm, document, registry, name, seen));
    }
  }
  return found;
}

function capabilityPathResolves(capabilityPath, registry) {
  const root = registry.byKey.get(CAPABILITIES_RESPONSE);
  if (!root) return false;
  let frontier = [{ schema: root.schema, document: root }];
  for (const segment of capabilityPath.split('.')) {
    const next = [];
    for (const entry of frontier) {
      next.push(...findPropertySchemas(entry.schema, entry.document, registry, segment));
    }
    if (next.length === 0) return false;
    frontier = next;
  }
  return true;
}

function validateValue(value, location, enums, registry) {
  const errors = [];
  if (!isObject(value)) {
    return [`${location}: ${ANNOTATION} must be an object`];
  }
  const keys = Object.keys(value);
  if (keys.length === 0) errors.push(`${location}: ${ANNOTATION} must name at least one key`);
  for (const key of keys) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push(`${location}: unknown key "${key}" (allowed: ${[...KNOWN_KEYS].join(', ')})`);
      continue;
    }
    const list = value[key];
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${location}: ${key} must be a non-empty array`);
      continue;
    }
    if (new Set(list).size !== list.length) {
      errors.push(`${location}: ${key} has duplicate values`);
    }
    for (const item of list) {
      if (typeof item !== 'string' || item.length === 0) {
        errors.push(`${location}: ${key} values must be non-empty strings`);
      } else if (key in ENUM_KEYS && !enums[key].has(item)) {
        errors.push(`${location}: ${key} value "${item}" is not in ${ENUM_KEYS[key]}`);
      } else if (key === 'capabilities' && !capabilityPathResolves(item, registry)) {
        errors.push(`${location}: capability path "${item}" does not resolve in ${CAPABILITIES_RESPONSE}`);
      }
    }
  }
  return errors;
}

function collectAnnotations(registry) {
  const annotations = [];
  const misplaced = [];

  function visit(node, document, pointer, isPropertyDeclaration) {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, document, `${pointer}/${index}`, false));
      return;
    }
    if (!isObject(node)) return;
    if (ANNOTATION in node && !isPropertyDeclaration) {
      misplaced.push(`${document.relativePath}#${pointer}`);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === ANNOTATION || NON_SCHEMA_KEYS.has(key)) continue;
      const childPointer = `${pointer}/${escapePointerToken(key)}`;
      if (key === 'properties' && isObject(child)) {
        const required = requiredNames(node);
        for (const [name, propertySchema] of Object.entries(child)) {
          const propertyPointer = `${childPointer}/${escapePointerToken(name)}`;
          if (isObject(propertySchema) && ANNOTATION in propertySchema) {
            annotations.push({
              document,
              name,
              pointer: propertyPointer,
              value: propertySchema[ANNOTATION],
              required: required.has(name),
            });
          }
          visit(propertySchema, document, propertyPointer, true);
        }
        continue;
      }
      visit(child, document, childPointer, false);
    }
  }

  for (const document of registry.documents) {
    visit(document.schema, document, '', false);
  }
  return { annotations, misplaced };
}

function lintAppliesWhen({ schemasDir = DEFAULT_SCHEMAS_DIR } = {}) {
  const registry = loadSchemaRegistry(schemasDir);
  const errors = registry.parseErrors.map((error) => `schema parse error: ${error}`);
  const enums = {};
  for (const [key, relativePath] of Object.entries(ENUM_KEYS)) {
    enums[key] = loadEnum(registry, relativePath, errors);
  }
  if (!registry.byKey.get(CAPABILITIES_RESPONSE)) {
    errors.push(`missing capabilities schema: ${CAPABILITIES_RESPONSE}`);
  }

  const { annotations, misplaced } = collectAnnotations(registry);
  for (const location of misplaced) {
    errors.push(`${location}: ${ANNOTATION} must sit on a property declaration`);
  }
  for (const annotation of annotations) {
    const location = `${annotation.document.relativePath}#${annotation.pointer}`;
    errors.push(...validateValue(annotation.value, location, enums, registry));
    if (annotation.required) {
      errors.push(`${location}: annotated property "${annotation.name}" is required by its parent; projections may only remove optional properties`);
    }
  }

  return { ok: errors.length === 0, errors, annotations };
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const schemasDir = path.resolve(readArg(args, '--schemas', DEFAULT_SCHEMAS_DIR));
  const result = lintAppliesWhen({ schemasDir });
  if (result.ok) {
    console.log(`✓ ${ANNOTATION} lint: ${result.annotations.length} annotated properties`);
    return;
  }
  console.error(`✗ ${ANNOTATION} lint failed with ${result.errors.length} error(s):\n`);
  result.errors.forEach((error) => console.error(`  - ${error}`));
  process.exitCode = 1;
}

module.exports = {
  ANNOTATION,
  KNOWN_KEYS,
  capabilityPathResolves,
  collectAnnotations,
  lintAppliesWhen,
};

if (require.main === module) main();
