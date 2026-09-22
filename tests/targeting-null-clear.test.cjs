const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static', 'schemas', 'source');
const VECTOR_PATH = path.join(
  ROOT,
  'static',
  'test-vectors',
  'media-buy',
  'targeting-null-clear.json'
);

function readSchema(uri) {
  const relative = uri.replace(/^\/schemas\//, '').split('#', 1)[0];
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, relative), 'utf8'));
}

async function loadExternalSchema(uri) {
  return readSchema(uri);
}

function applyDimensions(base, input) {
  const result = structuredClone(base);
  for (const [dimension, value] of Object.entries(input)) {
    if (value === null) delete result[dimension];
    else result[dimension] = structuredClone(value);
  }
  return result;
}

describe('request-only targeting null-clear semantics', () => {
  let validateInput;
  let validateState;
  let validatePackageRequest;
  let validatePackageUpdate;
  let validatePackageControl;
  let validateBuyProducts;

  before(async () => {
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema,
    });
    addFormats(ajv);
    const compile = async uri => ajv.getSchema(uri) || ajv.compileAsync(readSchema(uri));
    validateInput = await compile('/schemas/core/targeting-input.json');
    validateState = await compile('/schemas/core/targeting.json');
    validatePackageRequest = await compile('/schemas/media-buy/package-request.json');
    validatePackageUpdate = await compile('/schemas/media-buy/package-update.json');
    validatePackageControl = await compile('/schemas/media-buy/package-control.json');
    validateBuyProducts = await compile('/schemas/media-buy/buy-products-request.json');
  });

  test('every strict targeting dimension has an input null branch', () => {
    const strict = readSchema('/schemas/core/targeting.json');
    const input = readSchema('/schemas/core/targeting-input.json');
    assert.deepEqual(Object.keys(input.properties).sort(), Object.keys(strict.properties).sort());
    for (const dimension of Object.keys(strict.properties)) {
      if (Array.isArray(input.properties[dimension].type)) {
        assert.deepEqual(input.properties[dimension].type, ['array', 'null']);
        assert.deepEqual(
          { ...input.properties[dimension], type: 'array' },
          strict.properties[dimension],
          `${dimension} must match its strict targeting constraint`
        );
        continue;
      }
      const [nonNull, nullBranch] = input.properties[dimension].anyOf;
      assert.deepEqual(nullBranch, { type: 'null' });
      const strictPropertyRef = `/schemas/core/targeting.json#/properties/${dimension}`;
      if (nonNull.$ref === strictPropertyRef) continue;
      assert.deepEqual(
        nonNull,
        strict.properties[dimension],
        `${dimension} must match its strict targeting constraint`
      );
    }
    assert.equal(
      input.allOf.length,
      strict.allOf.length,
      'targeting input must cover every strict cross-field constraint'
    );
    assert.deepEqual(
      input.allOf,
      strict.allOf
    );
  });

  test('accepts null commands but keeps arrays non-empty when non-null', () => {
    for (const dimension of ['geo_regions', 'audience_include', 'audience_exclude']) {
      assert.equal(validateInput({ [dimension]: null }), true, JSON.stringify(validateInput.errors));
      assert.equal(validateInput({ [dimension]: [] }), false, `${dimension}: [] must not mean clear`);
      assert.equal(validateState({ [dimension]: null }), false, `${dimension}: null must not be state`);
    }
    assert.equal(validateInput({ geo_regions: ['AU-NSW'] }), true, JSON.stringify(validateInput.errors));
    assert.equal(validateInput({ audience_include: ['aud_1'] }), true, JSON.stringify(validateInput.errors));
    assert.equal(validateInput({ audience_exclude: ['aud_2'] }), true, JSON.stringify(validateInput.errors));
  });

  test('null applies only at the top-level dimension boundary', () => {
    assert.equal(validateInput({
      geo_metros: [{ system: 'nielsen_dma', values: null }],
    }), false);
  });

  test('all established and compact mutation inputs use the request-only shape', () => {
    assert.equal(validatePackageRequest({
      product_id: 'prod_1',
      pricing_option_id: 'price_1',
      targeting_overlay: { geo_regions: null },
    }), true, JSON.stringify(validatePackageRequest.errors));
    assert.equal(validatePackageUpdate({
      package_id: 'pkg_1',
      targeting_overlay: { audience_include: null },
    }), true, JSON.stringify(validatePackageUpdate.errors));
    assert.equal(validatePackageControl({
      package_id: 'pkg_1',
      targeting_overlay: { audience_exclude: null },
    }), true, JSON.stringify(validatePackageControl.errors));
    assert.equal(validateBuyProducts({
      idempotency_key: 'targeting-clear-buy-0001',
      account: { account_id: 'acc_1' },
      brand: { domain: 'acme.example' },
      feed_version: 'feed_1',
      purchases: [{
        product_id: 'prod_1',
        pricing_option_id: 'price_1',
        targeting_overlay: { geo_regions: null },
      }],
      total_budget: { amount: 1000, currency: 'USD' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z',
    }), true, JSON.stringify(validateBuyProducts.errors));
  });

  test('discovery, snapshot, and package readback refs remain strict', () => {
    const strictRef = '/schemas/core/targeting.json';
    const inputRef = '/schemas/core/targeting-input.json';
    assert.equal(readSchema('/schemas/media-buy/package-request.json').properties.targeting_overlay.$ref, inputRef);
    assert.equal(readSchema('/schemas/media-buy/package-update.json').properties.targeting_overlay.$ref, inputRef);
    assert.equal(readSchema('/schemas/media-buy/package-control.json').properties.targeting_overlay.$ref, inputRef);
    assert.equal(readSchema('/schemas/media-buy/product-purchase-input.json').properties.targeting_overlay.$ref, inputRef);
    assert.equal(readSchema('/schemas/media-buy/product-purchase.json').properties.targeting_overlay.$ref, strictRef);
    assert.equal(readSchema('/schemas/core/package.json').properties.targeting_overlay.$ref, strictRef);
    assert.equal(readSchema('/schemas/media-buy/product-discovery-criteria.json').properties.targeting_overlay.$ref, strictRef);
    assert.equal(readSchema('/schemas/media-buy/get-products-request.json').properties.targeting_overlay.$ref, strictRef);
    assert.equal(
      readSchema('/schemas/media-buy/get-media-buys-response.json')
        .properties.media_buys.items.properties.packages.items.properties.targeting_overlay.$ref,
      strictRef
    );
    assert.equal(
      readSchema('/schemas/media-buy/commercial-terms.json')
        .properties.purchases.items.allOf[0].$ref,
      '/schemas/media-buy/product-purchase.json'
    );
    assert.equal(
      readSchema('/schemas/media-buy/buy-products-request.json').properties.purchases.items.$ref,
      '/schemas/media-buy/product-purchase-input.json'
    );
  });

  test('codegen-safe product purchase input copies remain in strict-schema parity', () => {
    const strict = readSchema('/schemas/media-buy/product-purchase.json');
    const input = readSchema('/schemas/media-buy/product-purchase-input.json');
    assert.deepEqual(Object.keys(input.properties).sort(), Object.keys(strict.properties).sort());
    for (const property of Object.keys(strict.properties)) {
      if (property === 'targeting_overlay') continue;
      const strictPropertyRef = `/schemas/media-buy/product-purchase.json#/properties/${property}`;
      if (input.properties[property].$ref === strictPropertyRef) continue;
      assert.deepEqual(
        input.properties[property],
        strict.properties[property],
        `${property} must match its strict product purchase constraint`
      );
    }
  });

  test('machine-readable create and update vectors resolve to strict state', () => {
    const fixture = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'));
    assert.equal(fixture.request_schema, '/schemas/core/targeting-input.json');
    assert.equal(fixture.state_schema, '/schemas/core/targeting.json');
    assert.deepEqual(new Set(fixture.vectors.map(vector => vector.operation)), new Set(['create', 'update']));
    for (const vector of fixture.vectors) {
      const base = vector.operation === 'create' ? vector.product_defaults : vector.prior_state;
      assert.equal(validateState(base), true, `${vector.id} base: ${JSON.stringify(validateState.errors)}`);
      assert.equal(validateInput(vector.input), true, `${vector.id} input: ${JSON.stringify(validateInput.errors)}`);
      const actual = applyDimensions(base, vector.input);
      assert.deepEqual(actual, vector.expected_state, vector.id);
      assert.equal(validateState(actual), true, `${vector.id} result: ${JSON.stringify(validateState.errors)}`);
    }
  });

  test('older-version projections fail closed when a clear is not exactly representable', () => {
    const dimensions = ['geo_regions', 'audience_include', 'audience_exclude'];
    for (const version of ['3.0.0', '3.1.0']) {
      const legacy = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'dist', 'schemas', version, 'core', 'targeting.json'),
        'utf8'
      ));
      const ajv = new Ajv({ strict: false });
      for (const dimension of dimensions) {
        assert.ok(legacy.properties[dimension], `${version} lacks ${dimension}`);
        const prior = { [dimension]: dimension === 'geo_regions' ? ['AU-NSW'] : ['aud_existing'] };
        const completePostState = applyDimensions(prior, { [dimension]: null });
        assert.equal(Object.hasOwn(completePostState, dimension), false);
        assert.equal(ajv.validate(legacy.properties[dimension], null), false);
      }
    }

    const legacy25 = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'dist', 'schemas', '2.5.3', 'core', 'targeting.json'),
      'utf8'
    ));
    assert.equal(
      new Ajv({ strict: false }).validate(legacy25.properties.geo_region_any_of, []),
      true,
      '2.5 geography admits an empty list; adapters still verify semantic equivalence'
    );
    assert.equal(Object.hasOwn(legacy25.properties, 'audience_include'), false);
    assert.equal(Object.hasOwn(legacy25.properties, 'audience_exclude'), false);
  });
});
