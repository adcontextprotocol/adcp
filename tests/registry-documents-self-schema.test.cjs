'use strict';

// Registry documents carry data under their own keys and declare `$schema`.
// Each one must also state the schema of that data, so that the document is
// not the empty schema (which admits every JSON value) and so that a consumer
// can check a registry it fetched (adcontextprotocol/adcp#9104). The root
// requires no property yet: a new required name is not additive in a minor
// release (scripts/lint-additive-minor.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { buildExtensions } = require('../scripts/build-schemas.cjs');

const sourceRoot = path.join(__dirname, '../static/schemas/source');

function readSource(rel) {
  return JSON.parse(fs.readFileSync(path.join(sourceRoot, rel), 'utf8'));
}

function builtExtensionRegistry() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-registry-'));
  try {
    buildExtensions(sourceRoot, target, '3.3.0');
    return JSON.parse(fs.readFileSync(path.join(target, 'extensions/index.json'), 'utf8'));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

const registries = {
  'core/asset-group-vocabulary.json': () => readSource('core/asset-group-vocabulary.json'),
  'core/format-shape-vocabulary.json': () => readSource('core/format-shape-vocabulary.json'),
  'creative/asset-types/index.json': () => readSource('creative/asset-types/index.json'),
  'extensions/index.json (source)': () => readSource('extensions/index.json'),
  'extensions/index.json (published)': builtExtensionRegistry,
  'registries/v1-canonical-mapping.json': () => readSource('registries/v1-canonical-mapping.json'),
};

// Every other source schema, so a registry's $refs resolve.
function sourceSchemas(dir = sourceRoot, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceSchemas(file, out);
    else if (entry.name.endsWith('.json')) out.push(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return out;
}
const others = sourceSchemas().filter((schema) => typeof schema.$id === 'string');

for (const [name, load] of Object.entries(registries)) {
  test(`${name} validates against its own schema and is not the empty schema`, () => {
    const doc = load();
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
    addFormats(ajv);
    for (const schema of others) if (schema.$id !== doc.$id) ajv.addSchema(schema, schema.$id);
    const validate = ajv.compile(doc);
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    for (const value of [null, 0, [], 'registry']) {
      assert.equal(validate(value), false, `${name} admits ${JSON.stringify(value)}`);
    }
  });
}
