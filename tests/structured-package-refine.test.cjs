const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMAS = path.join(__dirname, '../static/schemas/source');
const PACKAGE_URI = '/schemas/media-buy/package-request.json';
const FORECAST_URI = '/schemas/media-buy/package-forecast-input.json';
const REQUEST_URI = '/schemas/media-buy/get-products-request.json';
const RESPONSE_URI = '/schemas/media-buy/get-products-response.json';
const CREATE_URI = '/schemas/media-buy/create-media-buy-request.json';
const read = (uri) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, uri.slice('/schemas/'.length)), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async (uri) => read(uri) });
addFormats(ajv);

let validateRequest;
let validateForecast;
let validatePackage;
let validateResponse;
let validateCreate;
before(async () => {
  // A single Ajv instance shares the PackageRequest refs across these validators.
  validateRequest = await ajv.compileAsync(read(REQUEST_URI));
  validateForecast = ajv.getSchema(FORECAST_URI);
  validatePackage = ajv.getSchema(PACKAGE_URI);
  validateResponse = await ajv.compileAsync(read(RESPONSE_URI));
  validateCreate = ajv.getSchema(CREATE_URI) || await ajv.compileAsync(read(CREATE_URI));
});

const proposedPackage = () => ({
  pricing_option_id: 'cpm_guaranteed',
  budget: 25000,
  start_time: '2026-11-01T00:00:00Z',
  end_time: '2026-11-30T23:59:59Z',
  targeting_overlay: { geo_countries: ['US'] },
});
const productFixture = () => ({
    product_id: 'prod_homepage_takeover',
    name: 'Homepage takeover',
    description: 'Guaranteed homepage display inventory.',
    publisher_properties: [{ publisher_domain: 'streamhaus.example', selection_type: 'all' }],
    format_ids: [{ agent_url: 'https://creatives.adcontextprotocol.org', id: 'display_300x250' }],
    delivery_type: 'guaranteed',
    pricing_options: [{ pricing_option_id: 'cpm_guaranteed', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'], expected_delay_minutes: 60, timezone: 'UTC',
      supports_webhooks: false, available_metrics: ['impressions'], date_range_support: 'date_range',
    },
});
const request = (entry = {}) => ({
  buying_mode: 'refine',
  refine: [{ scope: 'product', product_id: 'prod_homepage_takeover', package: proposedPackage(), ...entry }],
});
const check = (validate, value, expected = true) => {
  assert.equal(validate(value), expected, JSON.stringify(validate.errors, null, 2));
};

test('an exact package is optional and accepts explicit or default include without ask', () => {
  check(validateRequest, request());
  check(validateRequest, request({ action: 'include' }));
  check(validateRequest, { ...request(), fields: ['name'] });
  check(validateRequest, { buying_mode: 'refine', refine: [{ scope: 'product', product_id: 'prod_homepage_takeover' }] });
  for (const action of ['omit', 'more_like_this']) {
    check(validateRequest, { buying_mode: 'refine', refine: [{ scope: 'product', product_id: 'prod_homepage_takeover', action }] });
  }
  check(validateRequest, { buying_mode: 'refine', refine: [{ scope: 'proposal', proposal_id: 'prop_launch', action: 'finalize' }] });
  check(validateRequest, {
    buying_mode: 'refine',
    refine: [
      { scope: 'request', ask: 'Keep the same product selection' },
      ...request().refine,
      { scope: 'product', product_id: 'prod_display_ros', action: 'omit' },
    ],
  });
});

test('a package cannot be attached to omit, more_like_this, or other scopes', () => {
  for (const action of ['omit', 'more_like_this', 'finalize']) {
    check(validateRequest, request({ action }), false);
  }
  check(validateRequest, {
    buying_mode: 'refine',
    refine: [{ scope: 'request', ask: 'Check availability', package: proposedPackage() }],
  }, false);
  check(validateRequest, {
    buying_mode: 'refine',
    refine: [{ scope: 'proposal', proposal_id: 'prop_launch', package: proposedPackage() }],
  }, false);
  for (const buying_mode of ['brief', 'wholesale']) {
    check(validateRequest, { ...request(), buying_mode, ...(buying_mode === 'brief' ? { brief: 'Launch campaign' } : {}) }, false);
  }
  check(validateRequest, {
    buying_mode: 'refine',
    refine: [...request().refine, { scope: 'proposal', proposal_id: 'prop_launch', action: 'finalize' }],
  }, false);
});

test('pricing option and numeric budget are required and product identity is supplied only by the entry', () => {
  for (const key of ['pricing_option_id', 'budget']) {
    const pkg = proposedPackage();
    delete pkg[key];
    check(validateRequest, request({ package: pkg }), false);
  }
  for (const budget of [-1, '25000', { amount: 25000, currency: 'USD' }]) {
    check(validateRequest, request({ package: { ...proposedPackage(), budget } }), false);
  }
  check(validateRequest, request({ package: { ...proposedPackage(), product_id: 'prod_other' } }), false);
  check(validateRequest, request({ package: null }), false);
  check(validateRequest, request({ package: [] }), false);
  check(validateRequest, { buying_mode: 'refine', refine: [{ scope: 'product', package: proposedPackage() }] }, false);
});

test('flight dates may be inherited and package targeting preserves create inheritance and clear inputs', () => {
  const pkg = { pricing_option_id: 'cpm_guaranteed', budget: 25000 };
  check(validateRequest, {
    ...request({ package: pkg }),
    filters: { start_date: '2026-11-01', end_date: '2026-11-30' },
  });
  check(validateRequest, request({ package: { ...pkg, targeting_overlay: {} } }));
  check(validateRequest, request({ package: { ...pkg, impressions: 2500000, targeting_overlay: { geo_countries: null } } }));
  for (const update of [
    { start_time: 'asap' },
    { start_time: '2026-11-01' },
    { end_time: 'not-a-date' },
    { impressions: -1 },
    { targeting_overlay: { geo_countries: 'US' } },
  ]) {
    check(validateRequest, request({ package: { ...pkg, ...update } }), false);
  }
});

test('forecast fields and cross-field constraints stay aligned with create packages', () => {
  const booking = read(PACKAGE_URI);
  const forecast = read(FORECAST_URI);
  assert.deepEqual(Object.keys(forecast.properties), Object.keys(booking.properties).filter((key) => key !== 'product_id'));
  for (const [key, field] of Object.entries(forecast.properties)) {
    assert.equal(field.$ref, `${PACKAGE_URI}#/properties/${key}`);
  }
  assert.deepEqual(forecast.dependencies, booking.dependencies);
  assert.deepEqual(forecast.not, { $ref: `${PACKAGE_URI}#/not` });
  assert.deepEqual(forecast.allOf.slice(0, -1), booking.allOf.map((_, i) => ({ $ref: `${PACKAGE_URI}#/allOf/${i}` })));

  const cases = [
    [{}, true],
    [{ format_kind: 'image', params: { width: 300, height: 250 } }, true],
    [{ format_kind: 'image', params: { width: 300 } }, false],
    [{ params: { width: 300, height: 250 } }, false],
    [{ bidding: { automatic: true } }, true],
    [{ bidding: { automatic: true }, bid_price: 10 }, false],
    [{ bidding: { automatic: true }, optimization_goals: [
      { kind: 'metric', metric: 'clicks', priority: 1, target: { kind: 'cost_per', value: 1 } },
    ] }, false],
    [{ budget_cap_timezone: 'UTC' }, false],
    [{ capability_ids: ['unsupported'] }, false],
  ];
  for (const [extra, valid] of cases) {
    const pkg = { ...proposedPackage(), ...extra };
    check(validateForecast, pkg, valid);
    check(validatePackage, { product_id: 'prod_homepage_takeover', ...pkg }, valid);
  }
});

test('the existing response shape carries exact availability, shortfall, and unsupported-entry outcomes', () => {
  const product = productFixture();
  for (const [available, availability_status] of [[3000000, 'available'], [2000000, 'unavailable'], [0, 'unavailable']]) {
    const response = {
      status: 'completed',
      products: [{
        ...product,
        forecast: {
          forecast_range_unit: 'availability', method: 'modeled', currency: 'USD',
          generated_at: '2026-10-24T12:00:00Z', valid_until: '2026-10-24T12:05:00Z',
          points: [{ metrics: { impressions: { mid: available } }, availability_status }],
        },
      }],
      cache_scope: 'public',
      refinement_applied: [{
        scope: 'product', product_id: product.product_id, result_product_id: product.product_id,
        resolved_start_time: proposedPackage().start_time, resolved_end_time: proposedPackage().end_time,
        status: 'applied',
      }],
    };
    check(validateResponse, response);
  }
  check(validateResponse, {
    status: 'completed', products: [product], cache_scope: 'public',
    refinement_applied: [{ scope: 'product', product_id: product.product_id, status: 'unable', notes: 'The ad server cannot forecast this targeting.' }],
  });
  // Response validation has no request context: unchanged legacy outcomes remain valid.
  check(validateResponse, { status: 'completed', products: [product], cache_scope: 'public' });
});

test('new package inputs carry 3.3 version metadata without re-versioning the legacy task', () => {
  assert.equal(read(FORECAST_URI)['x-added-in'], '3.3.0');
  assert.equal(read(REQUEST_URI).properties.refine.items.oneOf[1].properties.package['x-added-in'], '3.3.0');
  assert.equal(read(REQUEST_URI)['x-added-in'], undefined);
  const receipt = read(RESPONSE_URI).properties.refinement_applied.items.oneOf[1];
  for (const name of ['result_product_id', 'resolved_start_time', 'resolved_end_time']) {
    assert.equal(receipt.properties[name]['x-added-in'], '3.3.0');
  }
});

test('reminted products and inherited local flight boundaries round-trip into create without relying on product order', () => {
  const input = {
    buying_mode: 'refine', adcp_version: '3.3', account: { account_id: 'account_streamhaus' },
    filters: { start_date: '2026-11-01', end_date: '2026-11-30' },
    targeting_overlay: { geo_countries: ['US'] },
    refine: [
      { scope: 'product', product_id: 'prod_homepage_takeover', package: {
        pricing_option_id: 'cpm_guaranteed', budget: 25000, targeting_overlay: { geo_countries: null },
      } },
      { scope: 'product', product_id: 'prod_display_ros', package: {
        pricing_option_id: 'cpm_guaranteed', budget: 5000, targeting_overlay: { geo_countries: ['CA'] },
      } },
    ],
  };
  const start = '2026-11-01T00:00:00-05:00';
  const end = '2026-11-30T23:59:59-05:00';
  const products = input.refine.map((entry, index) => ({
    ...productFixture(), product_id: `${entry.product_id}_configured`,
    is_custom: true, expires_at: '2026-10-24T12:05:00Z', overlay_support: { geo_countries: true },
    forecast: {
      forecast_range_unit: 'availability', method: 'modeled', currency: 'USD',
      points: [{ metrics: { impressions: { mid: index === 0 ? 3000000 : 600000 } }, availability_status: 'available' }],
    },
  }));
  const response = {
    status: 'completed', adcp_version: '3.3', cache_scope: 'account',
    products: [...products].reverse(),
    refinement_applied: input.refine.map((entry, index) => ({
      scope: 'product', product_id: entry.product_id, result_product_id: products[index].product_id,
      resolved_start_time: start, resolved_end_time: end, status: 'applied',
    })),
  };
  check(validateRequest, input);
  check(validateResponse, response);

  const packages = input.refine.map((entry, index) => {
    const outcome = response.refinement_applied[index];
    assert.equal(outcome.product_id, entry.product_id);
    const matching = response.products.filter((product) => product.product_id === outcome.result_product_id);
    assert.equal(matching.length, 1);
    const selectedPricing = matching[0].pricing_options.find((option) => option.pricing_option_id === entry.package.pricing_option_id);
    assert.deepEqual(selectedPricing, productFixture().pricing_options[0]);
    return {
      ...entry.package, product_id: outcome.result_product_id,
      start_time: outcome.resolved_start_time, end_time: outcome.resolved_end_time,
    };
  });
  check(validateCreate, {
    idempotency_key: 'forecast-purchase-0001', account: input.account,
    brand: { domain: 'nova-motors.example' }, start_time: start, end_time: end, packages,
  });
  assert.equal(packages[0].targeting_overlay.geo_countries, null);
  assert.equal(packages[0].product_id, response.products[1].product_id);
  assert.equal(packages[1].product_id, response.products[0].product_id);

  for (const key of ['result_product_id', 'resolved_start_time', 'resolved_end_time']) {
    const incomplete = structuredClone(response);
    delete incomplete.refinement_applied[0][key];
    check(validateResponse, incomplete, false);
  }
  for (const update of [{ result_product_id: '' }, { resolved_start_time: 'not-a-time' }, { status: 'unable' }]) {
    const invalid = structuredClone(response);
    Object.assign(invalid.refinement_applied[0], update);
    check(validateResponse, invalid, false);
  }
});
