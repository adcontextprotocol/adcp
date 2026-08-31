const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

function schemaPathFromId(schemaId) {
  return path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
}

async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
  return JSON.parse(fs.readFileSync(schemaPathFromId(uri), 'utf8'));
}

async function compile(schemaId) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: loadExternalSchema,
  });
  addFormats(ajv);
  return ajv.compileAsync(JSON.parse(fs.readFileSync(schemaPathFromId(schemaId), 'utf8')));
}

test('targeting accepts a selected collection set with explicit domain-qualified IDs', async () => {
  const validate = await compile('/schemas/core/targeting.json');
  const targeting = {
    collection_selection: {
      mode: 'selected',
      collections: [{
        publisher_domain: 'channel-owner.example',
        collection_ids: ['retro_news'],
      }],
    },
  };

  assert.equal(validate(targeting), true, JSON.stringify(validate.errors, null, 2));
});

test('a committed selection rejects the domain-only bulk-grant selector form', async () => {
  const validate = await compile('/schemas/core/targeting.json');
  const targeting = {
    collection_selection: {
      mode: 'selected',
      collections: [{ publisher_domain: 'channel-owner.example' }],
    },
  };

  assert.equal(validate(targeting), false,
    'selection selectors must name explicit collection_ids; bulk grants are authorization scoping');
});

test('targeting accepts the product-default collection selection', async () => {
  const validate = await compile('/schemas/core/targeting.json');
  const targeting = { collection_selection: { mode: 'default' } };

  assert.equal(validate(targeting), true, JSON.stringify(validate.errors, null, 2));
});

test('collection selection rejects unknown modes and empty selected sets', async () => {
  const validate = await compile('/schemas/core/targeting.json');

  assert.equal(validate({ collection_selection: { mode: 'all' } }), false, 'unknown mode');
  assert.equal(
    validate({ collection_selection: { mode: 'selected', collections: [] } }),
    false,
    'selected mode requires a non-empty set',
  );
  const duplicate = { publisher_domain: 'channel-owner.example', collection_ids: ['retro_news'] };
  assert.equal(
    validate({ collection_selection: { mode: 'selected', collections: [duplicate, { ...duplicate }] } }),
    false,
    'exact-duplicate selectors are rejected at schema level, mirroring placement_refs',
  );
});

test('resolved collection-list rows can carry the domain-qualified identity', async () => {
  const validate = await compile('/schemas/collection/get-collection-list-response.json');
  const response = {
    status: 'completed',
    list: {
      list_id: 'cl_test_001',
      name: 'Test list',
    },
    collections: [{
      publisher_domain: 'channel-owner.example',
      collection_id: 'retro_news',
      name: 'Acme Retro News',
      kind: 'channel',
    }],
  };

  const valid = validate(response);
  assert.equal(valid, true, JSON.stringify(validate.errors, null, 2));
});
