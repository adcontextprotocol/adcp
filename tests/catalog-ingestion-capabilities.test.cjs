const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');

async function loadSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

const declaration = {
  accepted_catalog_types: ['product', 'offering'],
  ingestion_modes: ['feed_url', 'inline_items'],
  supported_feed_formats: ['google_merchant_center', 'custom'],
  supported_content_id_types: ['sku', 'gtin'],
  max_inline_items_per_request: 10000,
  item_status_reporting: 'per_item',
};

function capabilities(features) {
  return {
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['media_buy'],
    media_buy: { features },
  };
}

test('catalog ingestion requires catalog_management on seller responses and preserves legacy declarations', async () => {
  const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  for (const features of [{}, { catalog_management: true }, { catalog_management: false }]) {
    assert.equal(validate(capabilities(features)), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate(capabilities({ catalog_management: true, catalog_ingestion: declaration })), true, JSON.stringify(validate.errors));
  for (const parent of [undefined, false, 'true', null]) {
    const features = { catalog_ingestion: declaration };
    if (parent !== undefined) features.catalog_management = parent;
    assert.equal(validate(capabilities(features)), false, `invalid parent: ${parent}`);
  }
  for (const invalid of [true, false, null, [], {}]) {
    assert.equal(validate(capabilities({ catalog_management: true, catalog_ingestion: invalid })), false);
  }
});

test('feed ingestion requires formats while inline-only ingestion can omit them', async () => {
  const validate = await compile('/schemas/core/catalog-ingestion-capability.json');
  const inline = {
    accepted_catalog_types: ['product'],
    ingestion_modes: ['inline_items'],
    item_status_reporting: 'feed_level',
  };
  assert.equal(validate(inline), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...inline, max_inline_items_per_request: 1 }), true);
  assert.equal(validate({ ...inline, ingestion_modes: ['feed_url'] }), false);
  assert.equal(validate({ ...inline, ingestion_modes: ['feed_url', 'inline_items'] }), false);
  const feed = { ...inline, ingestion_modes: ['feed_url'], supported_feed_formats: ['custom'] };
  assert.equal(validate(feed), true);
  assert.equal(validate({ ...feed, accepted_catalog_types: ['offering'], supported_feed_formats: [] }), true, 'native AdCP offering feeds need no external parser');
  assert.equal(validate({ ...inline, supported_content_id_types: [] }), true, 'custom identifiers omit content_id_type');
  assert.equal(validate({ ...feed, max_inline_items_per_request: 1 }), false);
  assert.equal(validate({ ...declaration, future_extension: { supported: true } }), true);
});

test('catalog ingestion lists reuse every canonical enum value and reject invalid declarations', async () => {
  const validate = await compile('/schemas/core/catalog-ingestion-capability.json');
  const enumFields = {
    accepted_catalog_types: 'catalog-type',
    supported_feed_formats: 'feed-format',
    supported_content_id_types: 'content-id-type',
  };
  for (const [field, enumName] of Object.entries(enumFields)) {
    const canonical = await loadSchema(`/schemas/enums/${enumName}.json`);
    assert.equal(validate({ ...declaration, [field]: canonical.enum }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...declaration, [field]: ['unknown_value'] }), false, field);
  }
  for (const field of [...Object.keys(enumFields), 'ingestion_modes']) {
    const acceptsEmpty = field === 'supported_feed_formats' || field === 'supported_content_id_types';
    assert.equal(validate({ ...declaration, [field]: [] }), acceptsEmpty, `empty ${field}`);
    const first = declaration[field][0];
    assert.equal(validate({ ...declaration, [field]: [first, first] }), false, `duplicate ${field}`);
    assert.equal(validate({ ...declaration, [field]: first }), false, `scalar ${field}`);
  }
  for (const field of ['accepted_catalog_types', 'ingestion_modes', 'item_status_reporting']) {
    const incomplete = { ...declaration };
    delete incomplete[field];
    assert.equal(validate(incomplete), false, `missing ${field}`);
  }
  for (const limit of [0, -1, 1.5, '10000']) {
    assert.equal(validate({ ...declaration, max_inline_items_per_request: limit }), false);
  }
  assert.equal(validate({ ...declaration, ingestion_modes: ['upload'] }), false);
  assert.equal(validate({ ...declaration, item_status_reporting: 'summary' }), false);
});

test('buyer feature filters retain independent boolean capability requests', async () => {
  const validate = await compile('/schemas/core/media-buy-features.json');
  assert.equal(validate({ catalog_management: true }), true);
  assert.equal(validate({ catalog_item_availability_updates: true }), true);
  assert.equal(validate({ future_feature: true }), true);
  assert.equal(validate({ future_feature: {} }), false);
});

test('existing catalog response entries can report approved and pending items without changing legacy results', async () => {
  const validate = await compile('/schemas/media-buy/sync-catalogs-response.json');
  const catalog = { catalog_id: 'product-feed', action: 'updated', item_count: 2 };
  assert.equal(validate({ status: 'completed', catalogs: [catalog] }), true);
  const result = {
    ...catalog,
    item_issues: [
      { item_id: 'SKU-12345', status: 'approved' },
      { item_id: 'SKU-67890', status: 'pending' },
    ],
  };
  assert.equal(validate({ status: 'completed', catalogs: [result] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ status: 'completed', catalogs: [{ ...catalog, item_issues: [{ item_id: 'SKU-12345', status: 'live' }] }] }), false);
});

test('buyers can read current review outcomes without supplying catalogs or restarting ingestion', async () => {
  const validateRequest = await compile('/schemas/media-buy/sync-catalogs-request.json');
  const validateResponse = await compile('/schemas/media-buy/sync-catalogs-response.json');
  const request = {
    idempotency_key: 'f6ca32d4-4567-49ab-8901-234567890abc',
    account: { account_id: 'acct_acmecorp' },
    catalog_ids: ['product-feed'],
  };
  assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
  const freshRead = { ...request, idempotency_key: '07db43e5-5678-4abc-9012-345678901bcd' };
  assert.equal(validateRequest(freshRead), true, JSON.stringify(validateRequest.errors));

  for (const status of ['pending', 'approved']) {
    assert.equal(validateResponse({
      status: 'completed',
      catalogs: [{
        catalog_id: 'product-feed',
        action: 'unchanged',
        item_count: 1,
        item_issues: [{ item_id: 'SKU-12345', status }],
      }],
    }), true, JSON.stringify(validateResponse.errors));
  }
  const schema = await loadSchema('/schemas/media-buy/sync-catalogs-response.json');
  const itemId = schema.oneOf[0].properties.catalogs.items.properties.item_issues.items.properties.item_id;
  assert.equal(itemId['x-entity'], 'catalog_item');
});
