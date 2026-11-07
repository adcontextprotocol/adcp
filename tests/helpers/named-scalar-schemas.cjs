'use strict';

/**
 * Registers every named scalar schema under core/ and enums/ with an Ajv
 * instance, so a test that compiles one source schema synchronously can
 * resolve the `$ref`s to them (#8525). Object schemas are not added: a test
 * that needs one still names it.
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

module.exports = { addNamedScalarSchemas, namedScalarSchemas, resolveScalar };
