#!/usr/bin/env node
/**
 * Detect object schemas whose `required` list names a property that no
 * `properties` block in scope declares.
 *
 * Why this lint exists
 * --------------------
 * JSON Schema validators enforce `required` whether or not the name appears
 * under `properties`, but code generators build types from `properties`. A
 * name that is required and undeclared therefore validates on the wire while
 * the generated SDK type has no such field, so a payload built from the type
 * is rejected by a validator. #8194 is the motivating example:
 * `validate-input-result.json` `warnings.items` required `field` without
 * declaring it.
 *
 * Declaration scope
 * -----------------
 * A required name counts as declared when it appears in:
 *   - the schema's own `properties`;
 *   - a `properties` block reached through the schema's own `$ref` or any
 *     `allOf` / `anyOf` / `oneOf` branch (recursively, following `$ref`s to
 *     other source files and to local `#/definitions` / `#/$defs`);
 *   - a `patternProperties` pattern that matches the name;
 *   - for a conditional branch (`if` / `then` / `else` / `allOf` / `anyOf` /
 *     `oneOf`), the declarations of any enclosing schema, one level up or
 *     further. Declarations are pooled across a schema's `anyOf`/`oneOf`/
 *     `then`/`else` arms, so a name declared in only one arm passes.
 *   - `not` subtrees are not checked: they name properties that must be absent. Branches routinely say `required: [x]` to constrain a
 *     property the parent declares.
 *
 * Schemas with an unresolvable `$ref` are skipped rather than reported.
 *
 * Allowlist
 * ---------
 * Intentional gaps go in ALLOWED as "relFile|jsonPath". Prefer declaring the
 * property; use the allowlist only when the gap is deliberate.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'static', 'schemas', 'source');

// Key: "relFile|jsonPath". Use * as the path for the whole file.
const ALLOWED = new Set([
  // Mixins composed through `allOf`; each composing branch declares `asset_type`.
  'core/format.json|/$defs/baseGroupAsset',
  'core/format.json|/$defs/baseIndividualAsset',
  // Standalone `allOf` fragment mixed into the targeting overlay, which declares `age_restriction`.
  'core/targeting-unknown-age-eligibility-constraint.json|/if',
  // Known declaration gaps in comply_test_controller injected-row shapes. The rows are specified as
  // complete core/ rows, so the right fix is a `$ref` choice, not a bare type. Listed in the #8194 PR
  // body for a follow-up; remove each entry when its declaration lands.
  'compliance/comply-test-controller-request.json|/allOf/1/then/properties/account',
  'compliance/comply-test-controller-request.json|/properties/params/properties/installment_property_delivery/items/properties/identifier',
  'compliance/comply-test-controller-request.json|/properties/params/properties/installment_property_delivery/items/properties/installment_ref',
  'compliance/comply-test-controller-request.json|/properties/params/properties/property_delivery/items/properties/identifier',
]);

const BRANCH_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function escapePointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function listSchemaFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSchemaFiles(full, out);
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function loadSchemas(schemaDir) {
  const docs = new Map(); // relFile -> doc
  for (const abs of listSchemaFiles(schemaDir)) {
    try {
      docs.set(path.relative(schemaDir, abs).split(path.sep).join('/'), JSON.parse(fs.readFileSync(abs, 'utf8')));
    } catch { /* skip malformed; other tests report it */ }
  }
  return docs;
}

function resolvePointer(doc, pointer) {
  let node = doc;
  for (const raw of pointer.split('/').filter(Boolean)) {
    if (!isPlainObject(node) && !Array.isArray(node)) return undefined;
    node = node[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/**
 * Resolve a `$ref` from `fromFile` to { file, doc, node }, or null.
 */
function resolveRef(ref, fromFile, docs) {
  const hashAt = ref.indexOf('#');
  const filePart = hashAt === -1 ? ref : ref.slice(0, hashAt);
  const pointer = hashAt === -1 ? '' : ref.slice(hashAt + 1);
  let file = fromFile;
  if (filePart) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(filePart)) return null;
    if (filePart.startsWith('/schemas/')) {
      file = filePart.slice('/schemas/'.length);
    } else if (filePart.startsWith('/')) {
      return null;
    } else {
      file = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), filePart));
    }
  }
  const doc = docs.get(file);
  if (doc === undefined) return null;
  const node = pointer ? resolvePointer(doc, pointer) : doc;
  if (node === undefined) return null;
  return { file, node };
}

/**
 * Expand `schema` into the list of schema nodes whose `properties` apply to
 * it: the schema itself, its own `$ref` target, and (when `conjunctiveOnly`
 * is false) every `allOf`/`anyOf`/`oneOf`/`then`/`else` branch. `complete`
 * goes false when a `$ref` could not be resolved, so the caller skips instead
 * of reporting a false positive.
 */
function expand(schema, file, docs, out, seen = new Set(), conjunctiveOnly = false) {
  if (!isPlainObject(schema) || seen.has(schema)) return;
  seen.add(schema);
  out.nodes.push({ schema, file });

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, file, docs);
    if (!target) out.complete = false;
    else expand(target.node, target.file, docs, out, seen, conjunctiveOnly);
  }
  const kws = conjunctiveOnly ? ['allOf'] : [...BRANCH_KEYWORDS, 'then', 'else'];
  for (const kw of kws) {
    const v = schema[kw];
    const branches = Array.isArray(v) ? v : isPlainObject(v) ? [v] : [];
    for (const branch of branches) expand(branch, file, docs, out, seen, conjunctiveOnly);
  }
}

function newScope() {
  return { nodes: [], complete: true };
}

function isDeclared(name, scope) {
  for (const { schema } of scope.nodes) {
    if (isPlainObject(schema.properties) && Object.hasOwn(schema.properties, name)) return true;
    if (isPlainObject(schema.patternProperties)) {
      for (const pattern of Object.keys(schema.patternProperties)) {
        try { if (new RegExp(pattern, 'u').test(name)) return true; } catch { /* ignore bad pattern */ }
      }
    }
  }
  return false;
}

/**
 * Subschemas that an enclosing declaring scope assigns to a child position,
 * expanded. A branch such as
 * `then: { properties: { params: { required: [...] } } }` narrows a `params`
 * the enclosing schema declared, so its declarations apply there too.
 * `kind` is `properties` (with `key`), `items`, or `patternProperties` (which
 * inherits every enclosing pattern and `additionalProperties` schema).
 */
function inheritedChild(scope, kind, key, docs) {
  const out = newScope();
  out.complete = scope.complete;
  for (const { schema, file } of scope.nodes) {
    let subs = [];
    if (kind === 'items') subs = [schema.items];
    else if (kind === 'properties' && isPlainObject(schema.properties)) subs = [schema.properties[key]];
    else if (kind === 'patternProperties') {
      subs = [
        ...(isPlainObject(schema.patternProperties) ? Object.values(schema.patternProperties) : []),
        schema.additionalProperties,
      ];
    }
    for (const sub of subs) if (isPlainObject(sub)) expand(sub, file, docs, out);
  }
  return out;
}

// Keywords whose value is a map of name -> subschema (fresh scope).
const SCHEMA_MAP_KEYWORDS = ['definitions', '$defs'];
// Keywords whose value is a single subschema (fresh scope).
const SCHEMA_KEYWORDS = [
  'additionalProperties', 'additionalItems', 'propertyNames', 'unevaluatedProperties',
  'unevaluatedItems',
];

function lintSchemas(docs) {
  const violations = [];

  /**
   * `inherited` holds the declaring scope contributed by enclosing schemas
   * (excluding `schema` itself); it is empty for a standalone schema.
   */
  function visit(schema, file, pointer, inherited) {
    if (Array.isArray(schema)) {
      schema.forEach((item, i) => visit(item, file, `${pointer}/${i}`, inherited));
      return;
    }
    if (!isPlainObject(schema)) return;

    const own = newScope();
    expand(schema, file, docs, own);
    const scope = {
      nodes: [...own.nodes, ...inherited.nodes],
      complete: own.complete && inherited.complete,
    };

    if (Array.isArray(schema.required) && schema.required.every((n) => typeof n === 'string')) {
      if (scope.complete && !ALLOWED.has(`${file}|${pointer || '/'}`) && !ALLOWED.has(`${file}|*`)) {
        const missing = schema.required.filter((n) => !isDeclared(n, scope));
        if (missing.length > 0) violations.push({ file, path: pointer, missing });
      }
    }

    // Branches may lean on enclosing declarations. A `not` branch names
    // properties that must be absent, so it is a negative constraint and is
    // not checked.
    for (const kw of BRANCH_KEYWORDS) {
      if (Array.isArray(schema[kw])) {
        schema[kw].forEach((branch, i) => visit(branch, file, `${pointer}/${kw}/${i}`, scope));
      }
    }
    for (const kw of ['if', 'then', 'else']) {
      if (isPlainObject(schema[kw])) visit(schema[kw], file, `${pointer}/${kw}`, scope);
    }
    if (isPlainObject(schema.dependentSchemas)) {
      for (const [key, sub] of Object.entries(schema.dependentSchemas)) {
        visit(sub, file, `${pointer}/dependentSchemas/${escapePointer(key)}`, scope);
      }
    }

    // Property and item subschemas start a fresh scope, plus whatever the
    // enclosing scopes declared for the same property or items.
    const conj = newScope();
    expand(schema, file, docs, conj, new Set(), true);
    const parentView = {
      nodes: [...conj.nodes.filter((n) => n.schema !== schema), ...inherited.nodes],
      complete: conj.complete && inherited.complete,
    };
    if (isPlainObject(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        visit(sub, file, `${pointer}/properties/${escapePointer(key)}`, inheritedChild(parentView, 'properties', key, docs));
      }
    }
    // `contains` matches an item, so it inherits the enclosing `items` too.
    for (const kw of ['items', 'contains']) {
      if (schema[kw] !== undefined) {
        visit(schema[kw], file, `${pointer}/${kw}`, inheritedChild(parentView, 'items', null, docs));
      }
    }
    if (isPlainObject(schema.patternProperties)) {
      for (const [key, sub] of Object.entries(schema.patternProperties)) {
        visit(sub, file, `${pointer}/patternProperties/${escapePointer(key)}`,
          inheritedChild(parentView, 'patternProperties', key, docs));
      }
    }
    for (const kw of SCHEMA_MAP_KEYWORDS) {
      if (!isPlainObject(schema[kw])) continue;
      for (const [key, sub] of Object.entries(schema[kw])) {
        visit(sub, file, `${pointer}/${kw}/${escapePointer(key)}`, newScope());
      }
    }
    for (const kw of SCHEMA_KEYWORDS) {
      if (schema[kw] !== undefined) visit(schema[kw], file, `${pointer}/${kw}`, newScope());
    }
  }

  for (const [file, doc] of docs) visit(doc, file, '', newScope());
  return violations;
}

function lint(schemaDir = SCHEMA_DIR) {
  const violations = lintSchemas(loadSchemas(schemaDir));
  violations.sort((a, b) => (a.file + a.path).localeCompare(b.file + b.path));
  return { violations };
}

if (require.main === module) {
  const { violations } = lint();
  if (violations.length === 0) {
    console.log('✓ schema required-declared lint: every required name is declared');
    process.exit(0);
  }
  console.error(`✗ schema required-declared lint: ${violations.length} schema(s) require undeclared properties\n`);
  for (const v of violations) {
    console.error(`  ${v.file}${v.path || ''}`);
    console.error(`    required but not declared: ${v.missing.join(', ')}`);
  }
  console.error(
    '\nDeclare each name under `properties` (own, `allOf`, or `$ref` branch). Generated SDK types are built from `properties`.',
  );
  process.exit(1);
}

module.exports = { lint, lintSchemas, loadSchemas, ALLOWED, SCHEMA_DIR };
