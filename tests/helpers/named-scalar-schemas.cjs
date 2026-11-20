'use strict';

/**
 * Registers every named scalar schema under core/ and enums/ with an Ajv
 * instance, so a test that compiles one source schema synchronously can
 * resolve the `$ref`s to them (#8525). Object schemas are not added: a test
 * that needs one still names it, or calls `addReferencedSchemas`.
 *
 * Tests that read schema structure by property path go through
 * `resolveSchema` and `schemaAt`, so a position that references a shared
 * definition reads as the definition with the site's annotations on top.
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'static', 'schemas', 'source');
const SCALAR_TYPES = new Set(['string', 'number', 'integer']);
let cache = null;

function namedScalarSchemas() {
  if (cache) return cache;
  cache = [];
  for (const dir of ['core', 'enums']) {
    for (const name of fs.readdirSync(path.join(SCHEMA_DIR, dir))) {
      if (!name.endsWith('.json')) continue;
      const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, dir, name), 'utf8'));
      const scalar = SCALAR_TYPES.has(schema.type)
        || (schema.type === undefined && (typeof schema.pattern === 'string' || Array.isArray(schema.enum)));
      if (scalar && typeof schema.$id === 'string') cache.push(schema);
    }
  }
  return cache;
}

/** Adds the named scalar schemas that `ajv` does not have yet, and returns `ajv`. */
function addNamedScalarSchemas(ajv) {
  for (const schema of namedScalarSchemas()) {
    if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema);
  }
  return ajv;
}

/**
 * A site with its named scalar schema resolved: the target's constraints with
 * the site's own siblings on top, as a validator sees them. `root` is the
 * document that holds the site, for a `#/definitions/...` reference. A site
 * that is not such a reference comes back unchanged.
 */
function resolveScalar(site, root) {
  if (!site || typeof site.$ref !== 'string') return site;
  let target;
  if (site.$ref.startsWith('#/')) {
    target = site.$ref.slice(2).split('/')
      .reduce((node, raw) => node?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  } else if (site.$ref.startsWith('/schemas/')) {
    target = namedScalarSchemas().find((schema) => schema.$id === site.$ref);
  }
  if (!target) return site;
  const { $schema, $id, title, description, ...constraints } = target;
  const { $ref, ...siblings } = site;
  return { ...constraints, ...siblings };
}

const documents = new Map();

/** The source document a `/schemas/...` URI names. Callers must not mutate it. */
function readNamedSchema(uri) {
  if (!documents.has(uri)) {
    const relative = uri.replace(/^\/schemas\//, '').replace(/#.*$/, '');
    documents.set(uri, JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relative), 'utf8')));
  }
  return documents.get(uri);
}

function pointerGet(root, pointer) {
  return pointer.split('/').filter(Boolean)
    .reduce((node, raw) => node?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'deprecated']);

/** `{ allOf: [{ $ref }] }` with only annotations beside it: a document that names another one. */
function singleReferenceAllOf(node) {
  return Array.isArray(node?.allOf) && node.allOf.length === 1
    && typeof node.allOf[0]?.$ref === 'string'
    && Object.keys(node).every((key) => key === 'allOf' || ANNOTATIONS.has(key) || key.startsWith('x-'));
}

/**
 * Follows a site's `$ref` to the schema it names, as a validator sees it: the
 * target's keywords with the site's own siblings (description, defaults,
 * x- annotations) on top. Chained references are followed, and so is a
 * document whose only constraint is `allOf: [{ $ref }]`. `root` is the
 * document that holds the site, for a `#/...` reference. Returns
 * `{ schema, root }`, where `root` is the document that holds the resolved
 * schema, for the next local reference. A site that is not a reference comes
 * back unchanged.
 */
function resolveWithRoot(site, root) {
  let node = site;
  let document = root;
  const seen = new Set();
  for (;;) {
    if (singleReferenceAllOf(node)) {
      const { allOf: [only], ...wrapper } = node;
      node = { ...wrapper, ...only };
    }
    if (!node || typeof node.$ref !== 'string' || seen.has(node.$ref)) break;
    seen.add(node.$ref);
    const [uri, fragment = ''] = node.$ref.split('#');
    let target;
    if (uri === '') {
      target = pointerGet(document, fragment);
    } else if (uri.startsWith('/schemas/')) {
      document = readNamedSchema(uri);
      target = fragment ? pointerGet(document, fragment) : document;
    }
    if (!target) break;
    const { $schema, $id, title, description, ...constraints } = target;
    const { $ref, ...siblings } = node;
    node = { ...constraints, ...siblings };
  }
  return { schema: node, root: document };
}

/** A site with its `$ref` resolved and the site's siblings overlaid. */
function resolveSchema(site, root) {
  return resolveWithRoot(site, root).schema;
}

/**
 * The schema at `keys` below `root`, read through every `$ref` on the way.
 * The node at the end is returned as written, so a test can still check its
 * own `$ref`; pass it to `resolveSchema` to read through it as well.
 */
function schemaAt(root, ...keys) {
  let node = root;
  let document = root;
  for (const key of keys) {
    ({ schema: node, root: document } = resolveWithRoot(node, document));
    node = node?.[key];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Adds to `ajv` every named document that `schema` references, directly or
 * through another named document, so `ajv.compile(schema)` resolves them
 * synchronously. Returns `ajv`.
 */
function addReferencedSchemas(ajv, schema) {
  const pending = [schema];
  const visited = new Set(schema && schema.$id ? [schema.$id] : []);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.$ref === 'string' && node.$ref.startsWith('/schemas/')) {
      const uri = node.$ref.split('#')[0];
      if (!visited.has(uri)) {
        visited.add(uri);
        const target = readNamedSchema(uri);
        if (!ajv.schemas[uri] && !ajv.refs[uri]) ajv.addSchema(target);
        pending.push(target);
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  while (pending.length) walk(pending.pop());
  return ajv;
}

module.exports = {
  addNamedScalarSchemas,
  addReferencedSchemas,
  namedScalarSchemas,
  readNamedSchema,
  resolveScalar,
  resolveSchema,
  schemaAt,
};
