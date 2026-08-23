const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const HORIZON = {
  start_time: '2099-09-01T00:00:00-04:00',
  end_time: '2099-10-01T00:00:00-04:00',
};

describe('flexible-window availability discovery', () => {
  let validateOfferFilters;
  let validateDimensions;
  let validateForecastPoint;
  let validateCanonicalPoint;

  before(async () => {
    [validateOfferFilters, validateDimensions, validateForecastPoint, validateCanonicalPoint] = await Promise.all([
      compile(readSchema('/schemas/core/product-offer-filters.json')),
      compile(readSchema('/schemas/core/forecast-point-dimensions.json')),
      compile(readSchema('/schemas/core/forecast-point.json')),
      compile(readSchema('/schemas/core/canonical-forecast-point.json')),
    ]);
  });

  it('accepts availability_horizon on its own', () => {
    assert.equal(
      validateOfferFilters({ availability_horizon: HORIZON }),
      true,
      JSON.stringify(validateOfferFilters.errors),
    );
  });

  it('accepts exact-flight start_date/end_date without a horizon', () => {
    assert.equal(
      validateOfferFilters({ start_date: '2099-09-01', end_date: '2099-09-27' }),
      true,
      JSON.stringify(validateOfferFilters.errors),
    );
  });

  it('rejects availability_horizon combined with either exact-flight date', () => {
    assert.equal(validateOfferFilters({ availability_horizon: HORIZON, start_date: '2099-09-01' }), false);
    assert.equal(validateOfferFilters({ availability_horizon: HORIZON, end_date: '2099-09-27' }), false);
    assert.equal(
      validateOfferFilters({ availability_horizon: HORIZON, start_date: '2099-09-01', end_date: '2099-09-27' }),
      false,
    );
  });

  it('requires both horizon bounds and forbids extra horizon fields', () => {
    assert.equal(validateOfferFilters({ availability_horizon: { start_time: HORIZON.start_time } }), false);
    assert.equal(validateOfferFilters({ availability_horizon: { end_time: HORIZON.end_time } }), false);
    assert.equal(
      validateOfferFilters({ availability_horizon: { ...HORIZON, timezone: 'America/New_York' } }),
      false,
    );
  });

  it('accepts a time dimension and rejects one missing either bound', () => {
    const time = { kind: 'time', start_time: HORIZON.start_time, end_time: HORIZON.end_time };
    assert.equal(validateDimensions([time]), true, JSON.stringify(validateDimensions.errors));
    assert.equal(validateDimensions([{ kind: 'time', start_time: HORIZON.start_time }]), false);
    assert.equal(validateDimensions([{ kind: 'time', end_time: HORIZON.end_time }]), false);
  });

  it('accepts availability_status with empty metrics on both forecast points', () => {
    const point = {
      dimensions: [{ kind: 'time', start_time: HORIZON.start_time, end_time: HORIZON.end_time }],
      availability_status: 'unavailable',
      metrics: {},
    };
    assert.equal(validateForecastPoint(point), true, JSON.stringify(validateForecastPoint.errors));
    assert.equal(validateCanonicalPoint(point), true, JSON.stringify(validateCanonicalPoint.errors));
  });

  it('rejects availability_status values outside the enum', () => {
    const point = {
      dimensions: [{ kind: 'time', start_time: HORIZON.start_time, end_time: HORIZON.end_time }],
      availability_status: 'limited',
      metrics: {},
    };
    assert.equal(validateCanonicalPoint(point), false);
  });
});
