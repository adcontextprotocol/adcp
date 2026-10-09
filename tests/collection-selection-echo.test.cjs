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

test('canonical products expose collection composition for compact-lifecycle selection', async () => {
  const validate = await compile('/schemas/core/canonical-product.json');
  const product = {
    product_id: 'retro_news_bundle',
    name: 'Retro news bundle',
    collections: [{
      publisher_domain: 'channel-owner.example',
      collection_ids: ['retro_news', 'retro_sports'],
    }],
    collection_targeting_allowed: true,
    overlay_support: { collection_list: true },
  };
  assert.equal(validate(product), true, JSON.stringify(validate.errors, null, 2));

  assert.equal(validate({ ...product, collections: [] }), false,
    'an empty collections array is not a composition');
  assert.equal(validate({
    ...product,
    collections: [{ publisher_domain: 'channel-owner.example' }],
  }), false, 'product composition names explicit collection_ids, not the bulk-grant form');

  const fixedBundle = { ...product };
  delete fixedBundle.collection_targeting_allowed;
  assert.equal(validate(fixedBundle), false,
    'overlay_support.collection_list requires collection_targeting_allowed');
  assert.equal(validate({ ...product, collection_targeting_allowed: false }), false,
    'overlay_support.collection_list requires collection_targeting_allowed: true');
  delete fixedBundle.overlay_support;
  assert.equal(validate(fixedBundle), true, JSON.stringify(validate.errors, null, 2));

  const canonical = JSON.parse(fs.readFileSync(schemaPathFromId('/schemas/core/canonical-product.json'), 'utf8'));
  const legacy = JSON.parse(fs.readFileSync(schemaPathFromId('/schemas/core/product.json'), 'utf8'));
  assert.deepEqual(canonical.properties.collections.items, legacy.properties.collections.items);
  assert.equal(canonical.properties.collection_targeting_allowed.default, false);
  const fields = JSON.parse(fs.readFileSync(schemaPathFromId('/schemas/media-buy/product-fields.json'), 'utf8'));
  for (const field of ['collections', 'collection_targeting_allowed']) {
    assert.ok(fields.items.enum.includes(field), `list_products fields must project ${field}`);
  }
});
