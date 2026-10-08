const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');
const REASONS = ['renewal', 'terms_change', 'migration', 'sunset'];

function readSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const lineage = { predecessor_media_buy_id: 'mb_pinnacle_q3', lineage_reason: 'renewal' };

const REQUESTS = {
  create_media_buy: {
    uri: '/schemas/media-buy/create-media-buy-request.json',
    base: {
      idempotency_key: '6f1d0a52-7c3e-4b1a-9e0d-2a5b8c4d7e91',
      account: { account_id: 'acct_nova_brands' },
      brand: { domain: 'novabrands.example' },
      start_time: '2026-10-01T00:00:00Z',
      end_time: '2026-12-31T23:59:59Z',
      total_budget: { amount: 40000, currency: 'USD' },
      packages: [{ product_id: 'prod_d979b543', pricing_option_id: 'cpm_usd_auction', budget: 40000 }],
    },
  },
  buy_products: {
    uri: '/schemas/media-buy/buy-products-request.json',
    base: {
      idempotency_key: '6f1d0a52-7c3e-4b1a-9e0d-2a5b8c4d7e92',
      account: { account_id: 'acct_nova_brands' },
      brand: { domain: 'novabrands.example' },
      feed_version: 'products-2027-06-01T12:00:00Z',
      purchases: [{ product_id: 'product_display_standard', pricing_option_id: 'cpm_usd', budget: 50000 }],
      start_time: 'asap',
      end_time: '2027-07-01T00:00:00Z',
    },
  },
  accept_proposal: {
    uri: '/schemas/media-buy/accept-proposal-request.json',
    base: {
      idempotency_key: '6f1d0a52-7c3e-4b1a-9e0d-2a5b8c4d7e93',
      account: { account_id: 'acct_nova_brands' },
      proposal_id: 'proposal_committed_456',
      proposal_terms_digest: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  },
};

test('lineage reason is a closed four-value enum registered in the schema index', () => {
  assert.deepEqual(readSchema('/schemas/enums/media-buy-lineage-reason.json').enum, REASONS);
  const entry = readSchema('/schemas/index.json').schemas.enums.schemas['media-buy-lineage-reason'];
  assert.equal(entry.$ref, '/schemas/enums/media-buy-lineage-reason.json');
});

for (const [task, { uri, base }] of Object.entries(REQUESTS)) {
  test(`${task} accepts a forward-only lineage link and keeps lineage optional`, async () => {
    const validate = await compile(readSchema(uri));
    assert.equal(validate(base), true, `base invalid: ${JSON.stringify(validate.errors)}`);
    for (const lineage_reason of REASONS) {
      const body = { ...base, predecessor_media_buy_id: 'mb_pinnacle_q3', lineage_reason };
      assert.equal(validate(body), true, `${lineage_reason}: ${JSON.stringify(validate.errors)}`);
    }
  });

  test(`${task} requires the two lineage fields together and rejects off-enum reasons`, async () => {
    const validate = await compile(readSchema(uri));
    assert.equal(validate({ ...base, predecessor_media_buy_id: 'mb_pinnacle_q3' }), false);
    assert.equal(validate({ ...base, lineage_reason: 'renewal' }), false);
    assert.equal(validate({ ...base, ...lineage, lineage_reason: 'replacement' }), false);
    assert.equal(validate({ ...base, ...lineage, predecessor_media_buy_id: '' }), false);
  });

  test(`${task} carries no write-back field for the predecessor`, () => {
    const props = readSchema(uri).properties;
    assert.equal(props.predecessor_media_buy_id['x-entity'], 'media_buy');
    assert.equal('replacement_media_buy_id' in props, false);
  });
}

test('the core media buy pairs the lineage fields', async () => {
  const validate = await compile(readSchema('/schemas/core/media-buy.json'));
  const buy = { media_buy_id: 'mb_pinnacle_q4', status: 'active', confirmed_at: '2026-09-28T15:00:00Z', revision: 1, total_budget: 40000, packages: [] };
  assert.equal(validate({ ...buy, ...lineage }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...buy, predecessor_media_buy_id: 'mb_pinnacle_q3' }), false);
  assert.equal(validate({ ...buy, lineage_reason: 'renewal' }), false);
});

test('get_media_buys filters by predecessor_media_buy_id', async () => {
  const schema = readSchema('/schemas/media-buy/get-media-buys-request.json');
  assert.equal(schema.properties.predecessor_media_buy_id['x-entity'], 'media_buy');
  assert.equal(schema.properties.predecessor_media_buy_id.type, 'string');
  const validate = await compile(schema);
  assert.equal(validate({ predecessor_media_buy_id: 'mb_pinnacle_q3', status_filter: ['active'] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ predecessor_media_buy_id: '' }), false);
});

test('get_media_buys items and the core media buy echo the lineage fields', async () => {
  const response = readSchema('/schemas/media-buy/get-media-buys-response.json');
  const item = response.properties.media_buys.items;
  const core = readSchema('/schemas/core/media-buy.json');
  for (const schema of [item, core]) {
    assert.equal(schema.properties.predecessor_media_buy_id['x-entity'], 'media_buy');
    assert.equal(schema.properties.lineage_reason.$ref, '/schemas/enums/media-buy-lineage-reason.json');
    assert.equal(schema.required.includes('predecessor_media_buy_id'), false);
    assert.equal('replacement_media_buy_id' in schema.properties, false);
  }
  const validate = await compile(response);
  const buy = {
    media_buy_id: 'mb_pinnacle_q4',
    status: 'active',
    confirmed_at: '2026-09-28T15:00:00Z',
    currency: 'USD',
    total_budget: 40000,
    revision: 1,
    packages: [],
  };
  const wrap = (mb) => ({ status: 'completed', media_buys: [mb] });
  assert.equal(validate(wrap(buy)), true, JSON.stringify(validate.errors));
  assert.equal(validate(wrap({ ...buy, ...lineage })), true, JSON.stringify(validate.errors));
  assert.equal(validate(wrap({ ...buy, predecessor_media_buy_id: 'mb_pinnacle_q3' })), false);
  assert.equal(validate(wrap({ ...buy, ...lineage, lineage_reason: 'replacement' })), false);
});
