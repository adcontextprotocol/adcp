const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.join(__dirname, '../static/schemas/source');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
async function compile(file) {
  const ajv = new Ajv({ strict: false, allErrors: true, loadSchema: async uri => {
    assert.ok(uri.startsWith('/schemas/'), `Unexpected schema reference: ${uri}`);
    return read(uri.slice('/schemas/'.length));
  } });
  addFormats(ajv);
  return ajv.compileAsync(read(file));
}
const declaration = { provider: 'provider_7', purpose: 'measurement', required: true };
const applied = { ...declaration, position: 'append', status: 'applied' };

test('declarations require an opaque provider, a purpose, and an explicit required policy', async () => {
  const validate = await compile('core/adjacent-code.json');
  for (const data of [declaration, { ...declaration, provider: 'seller', required: false },
    { ...declaration, purpose: 'publisher-specific purpose', future_detail: 'tolerated' }]) {
    assert.equal(validate(data), true, JSON.stringify(validate.errors));
  }
  for (const field of ['provider', 'purpose', 'required']) {
    const missing = { ...declaration };
    delete missing[field];
    assert.equal(validate(missing), false, field);
  }
  for (const invalid of [null, {}, { ...declaration, provider: '' },
    { ...declaration, provider: { domain: 'vendor.example' } },
    { ...declaration, provider: 'https://vendor.example/api' },
    { ...declaration, purpose: '' }, { ...declaration, required: 'true' }]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
});

test('readback requires a placement and a known application state, without closing extensions', async () => {
  const validate = await compile('core/adjacent-code-application.json');
  for (const status of ['applied', 'pending', 'omitted']) {
    for (const position of ['prepend', 'append']) {
      assert.equal(validate({ ...applied, status, position }), true, JSON.stringify(validate.errors));
    }
  }
  assert.equal(validate({ ...applied, future_detail: 'tolerated' }), true);
  for (const field of ['provider', 'purpose', 'required', 'position', 'status']) {
    const missing = { ...applied };
    delete missing[field];
    assert.equal(validate(missing), false, field);
  }
  for (const data of [{ ...applied, position: 1 }, { ...applied, position: 'inside' },
    { ...applied, status: 'approved' }, { ...applied, status: null }]) {
    assert.equal(validate(data), false, JSON.stringify(data));
  }
});

const product = { product_id: 'display', name: 'Display' };
const legacyProduct = {
  ...product, description: 'Publisher display',
  publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'by_id', property_ids: ['homepage'] }],
  format_ids: [{ agent_url: 'https://formats.example/agent', id: 'display_300x250' }],
  delivery_type: 'non_guaranteed',
  pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', currency: 'USD', rate: 2 }],
  reporting_capabilities: { available_reporting_frequencies: ['daily'], expected_delay_minutes: 60,
    timezone: 'UTC', supports_webhooks: false, available_metrics: ['impressions'], date_range_support: 'date_range' }
};

for (const [file, base] of [['core/canonical-product.json', product], ['core/product.json', legacyProduct]]) {
  test(`${file}: optional disclosure accepts absence and an empty roster but validates declared entries`, async () => {
    const validate = await compile(file);
    for (const data of [base, { ...base, adjacent_code: [] }, { ...base, adjacent_code: [declaration] }]) {
      assert.equal(validate(data), true, JSON.stringify(validate.errors));
    }
    for (const adjacent_code of [null, {}, [applied, { provider: 'seller' }],
      [{ ...declaration, required: null }]]) {
      assert.equal(validate({ ...base, adjacent_code }), false, JSON.stringify(adjacent_code));
    }
  });
}

test('product field projection accepts adjacent_code alongside ordinary discovery fields', async () => {
  const validate = await compile('media-buy/product-fields.json');
  assert.equal(validate(['product_id', 'adjacent_code']), true, JSON.stringify(validate.errors));
});

const readbacks = [
  {
    file: 'creative/list-creatives-response.json',
    data: { status: 'completed', query_summary: { total_matching: 1, returned: 1 }, pagination: { has_more: false },
      creatives: [{ creative_id: 'hero', name: 'Hero', format_kind: 'image', status: 'approved',
        created_date: '2026-11-16T12:00:00Z', updated_date: '2026-11-16T12:00:00Z',
        assignments: { assignment_count: 1, returned_assignment_count: 1, assignments_truncated: false,
          assigned_packages: [{ media_buy_id: 'mb_display', package_id: 'pkg_display',
            assigned_date: '2026-11-16T12:00:00Z', approval_status: 'approved' }] } }] },
    row: data => data.creatives[0].assignments.assigned_packages[0]
  },
  {
    file: 'media-buy/get-media-buys-response.json',
    data: { status: 'completed', media_buys: [{ media_buy_id: 'mb_display', status: 'active', currency: 'USD',
      total_budget: 1000, confirmed_at: '2026-11-16T12:00:00Z', revision: 1,
      packages: [{ package_id: 'pkg_display', creative_approvals: [{ creative_id: 'hero', approval_status: 'approved' }] }] }] },
    row: data => data.media_buys[0].packages[0].creative_approvals[0]
  }
];

for (const { file, data, row } of readbacks) {
  test(`${file}: validates assignment application states independently of creative approval`, async () => {
    const validate = await compile(file);
    assert.equal(validate(data), true, JSON.stringify(validate.errors));
    for (const adjacent_code of [[], [applied], [{ ...applied, status: 'pending' }],
      [{ ...applied, status: 'omitted' }], [{ ...applied, required: false, status: 'omitted' }]]) {
      const message = structuredClone(data);
      row(message).adjacent_code = adjacent_code;
      assert.equal(validate(message), true, JSON.stringify(validate.errors));
    }
    for (const adjacent_code of [null, [declaration], [{ ...applied, status: 'approved' }],
      [{ ...applied, provider: { domain: 'vendor.example' } }]]) {
      const message = structuredClone(data);
      row(message).adjacent_code = adjacent_code;
      assert.equal(validate(message), false, JSON.stringify(adjacent_code));
    }
  });
}

test('assignment invalidations accept adjacent-code changes without changing the relationship envelope', async () => {
  const validate = await compile('creative/creative-assignment-changed-webhook.json');
  const event = {
    idempotency_key: 'adjacent-change-0001', notification_id: 'adjacent_change_1',
    notification_type: 'creative.assignment_changed', fired_at: '2026-11-16T12:01:00Z',
    subscriber_id: 'buyer-primary', account_id: 'account_a', media_buy_id: 'mb_display',
    package_id: 'pkg_display', creative_id: 'hero', change_kind: 'adjacent_code_changed',
    observed_at: '2026-11-16T12:00:00Z'
  };
  for (const change_kind of ['assigned', 'unassigned', 'approval_changed', 'adjacent_code_changed']) {
    assert.equal(validate({ ...event, change_kind }), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ ...event, change_kind: 'configuration_edited' }), false);
  const missingRelationship = { ...event };
  delete missingRelationship.package_id;
  assert.equal(validate(missingRelationship), false);
});
