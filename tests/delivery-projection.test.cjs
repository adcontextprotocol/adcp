const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');

function readSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const projection = {
  projected_impressions: 1180000,
  projected_spend: 9440.0,
  projected_end_state: 'underdelivery',
  basis: 'trailing_daily_avg',
  as_of: '2026-10-01T00:00:00Z',
};

const packageRow = (by_package) => by_package.items.allOf.find((part) => part.properties && part.properties.package_id);

function deliveryRowSchema() {
  return packageRow(
    readSchema('/schemas/media-buy/get-media-buy-delivery-response.json').properties.media_buy_deliveries.items.properties
      .by_package
  );
}

test('projection is an optional ref on top-level by_package rows only', () => {
  const row = deliveryRowSchema();
  assert.equal(row.properties.projection.$ref, '/schemas/core/delivery-projection.json');
  assert.ok(!(row.required || []).includes('projection'));
  const windows = packageRow(
    readSchema('/schemas/media-buy/get-media-buy-delivery-response.json').properties.media_buy_deliveries.items.properties
      .windows.items.properties.by_package
  );
  assert.equal(windows.properties.projection, undefined);
});

test('projection requires end state, basis, and as_of; volumes are optional', () => {
  const core = readSchema('/schemas/core/delivery-projection.json');
  assert.deepEqual(core.required, ['projected_end_state', 'basis', 'as_of']);
  assert.equal(core.properties.projected_end_state.$ref, '/schemas/enums/delivery-projection-end-state.json');
  assert.deepEqual(readSchema('/schemas/enums/delivery-projection-end-state.json').enum, [
    'on_pace',
    'complete',
    'underdelivery',
    'early_exhaustion',
  ]);
  assert.equal(core.properties.basis.$ref, '/schemas/enums/delivery-projection-basis.json');
});

test('enumDescriptions cover exactly the enum values', () => {
  const basis = readSchema('/schemas/enums/delivery-projection-basis.json');
  assert.deepEqual(Object.keys(basis.enumDescriptions).sort(), [...basis.enum].sort());
  const state = readSchema('/schemas/enums/delivery-projection-end-state.json');
  assert.deepEqual(Object.keys(state.enumDescriptions).sort(), [...state.enum].sort());
});

test('basis is the four-value method-class set', () => {
  assert.deepEqual(readSchema('/schemas/enums/delivery-projection-basis.json').enum, [
    'trailing_daily_avg',
    'trailing_hourly_avg',
    'platform_model',
    'seller_defined',
  ]);
});

test('advisory wording is present', () => {
  const text = JSON.stringify(readSchema('/schemas/core/delivery-projection.json'));
  assert.match(text, /advisory forecast, not a delivery record/);
  assert.match(text, /no contractual meaning on its own/);
  assert.match(text, /governed by the parties' terms/);
});

test('projection validates and rejects malformed values', async () => {
  const validate = await compile('/schemas/core/delivery-projection.json');
  assert.ok(validate(projection), JSON.stringify(validate.errors));
  assert.ok(validate({ projected_end_state: 'on_pace', basis: 'seller_defined', as_of: '2026-10-01T00:00:00Z' }));
  assert.ok(!validate({ ...projection, projected_end_state: 'overdelivery' }));
  assert.ok(!validate({ ...projection, basis: 'trailing_7d_avg' }));
  assert.ok(!validate({ ...projection, projected_impressions: -1 }));
  const { as_of, ...withoutAsOf } = projection;
  assert.ok(!validate(withoutAsOf));
  assert.ok(!validate({ ...projection, as_of: 'yesterday' }));
  assert.ok(!validate({ ...projection, projected_spend: -1 }));
});

test('a delivery response with and without projection both validate', async () => {
  const validate = await compile('/schemas/media-buy/get-media-buy-delivery-response.json');
  const pkg = { package_id: 'pkg_ctv_prime', impressions: 400000, spend: 3200.0, pacing_index: 0.85, pricing_model: 'cpm', rate: 8.0, currency: 'USD' };
  const response = (by_package) => ({
    reporting_period: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
    status: 'completed',
    currency: 'USD',
    media_buy_deliveries: [
      {
        media_buy_id: 'mb_pinnacle_fall',
        status: 'active',
        totals: { impressions: 400000, spend: 3200.0 },
        by_package,
      },
    ],
  });
  assert.ok(validate(response([pkg])), JSON.stringify(validate.errors));
  assert.ok(validate(response([{ ...pkg, projection }])), JSON.stringify(validate.errors));
  assert.ok(!validate(response([{ ...pkg, projection: { ...projection, basis: 'ml_forecast' } }])));
});

test('projection surface is experimental, versioned, and registered', () => {
  const row = deliveryRowSchema().properties.projection;
  const files = [
    readSchema('/schemas/core/delivery-projection.json'),
    readSchema('/schemas/enums/delivery-projection-basis.json'),
    readSchema('/schemas/enums/delivery-projection-end-state.json'),
    row,
  ];
  for (const schema of files) {
    assert.equal(schema['x-status'], 'experimental');
    assert.equal(schema['x-added-in'], '3.3.0');
  }
  const registry = fs.readFileSync(path.join(__dirname, '../docs/reference/experimental-status.mdx'), 'utf8');
  assert.match(registry, /^\| `media_buy\.delivery_projection` \|/m);
  const basis = readSchema('/schemas/core/delivery-projection.json').properties.basis.description;
  assert.match(basis, /forecast-method\.json/);
});

test('projection schemas are registered in the schema index', () => {
  const index = readSchema('/schemas/index.json');
  assert.equal(index.schemas.core.schemas['delivery-projection'].$ref, '/schemas/core/delivery-projection.json');
  assert.equal(
    index.schemas.enums.schemas['delivery-projection-basis'].$ref,
    '/schemas/enums/delivery-projection-basis.json'
  );
  assert.equal(
    index.schemas.enums.schemas['delivery-projection-end-state'].$ref,
    '/schemas/enums/delivery-projection-end-state.json'
  );
});
