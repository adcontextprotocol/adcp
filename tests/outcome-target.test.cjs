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

describe('outcome_target reverse-forecast criteria', () => {
  let validateCriteria;

  before(async () => {
    validateCriteria = await compile(readSchema('/schemas/media-buy/product-discovery-criteria.json'));
  });

  it('accepts a delivery-metric goal with a volume', () => {
    const criteria = {
      outcome_target: {
        goal: { kind: 'metric', metric: 'clicks' },
        volume: 10000,
      },
    };
    assert.equal(validateCriteria(criteria), true, JSON.stringify(validateCriteria.errors));
  });

  it('accepts every goal metric as a forecast metrics key by construction', () => {
    const forecastable = readSchema('/schemas/enums/forecastable-metric.json').enum;
    for (const metric of forecastable) {
      const criteria = { outcome_target: { goal: { kind: 'metric', metric }, volume: 10 } };
      assert.equal(validateCriteria(criteria), true, `${metric}: ${JSON.stringify(validateCriteria.errors)}`);
    }
  });

  it('accepts a conversion-event goal, requiring custom_event_name only for custom', () => {
    assert.equal(
      validateCriteria({ outcome_target: { goal: { kind: 'event', event_type: 'purchase' }, volume: 1800 } }),
      true,
      JSON.stringify(validateCriteria.errors),
    );
    assert.equal(
      validateCriteria({ outcome_target: { goal: { kind: 'event', event_type: 'custom' }, volume: 50 } }),
      false,
    );
    assert.equal(
      validateCriteria({
        outcome_target: {
          goal: { kind: 'event', event_type: 'custom', custom_event_name: 'trial_extended' },
          volume: 50,
        },
      }),
      true,
      JSON.stringify(validateCriteria.errors),
    );
  });

  it('requires both goal and volume', () => {
    assert.equal(validateCriteria({ outcome_target: { volume: 10000 } }), false);
    assert.equal(
      validateCriteria({ outcome_target: { goal: { kind: 'metric', metric: 'clicks' } } }),
      false,
    );
  });

  it('rejects non-positive volumes and unknown outcome_target fields', () => {
    const goal = { kind: 'metric', metric: 'clicks' };
    assert.equal(validateCriteria({ outcome_target: { goal, volume: 0 } }), false);
    assert.equal(validateCriteria({ outcome_target: { goal, volume: -5 } }), false);
    assert.equal(
      validateCriteria({ outcome_target: { goal, volume: 100, currency: 'USD' } }),
      false,
    );
  });

  it('rejects goals outside the compact planning union', () => {
    assert.equal(
      validateCriteria({ outcome_target: { goal: { kind: 'metric', metric: 'brand_awareness' }, volume: 10 } }),
      false,
    );
    assert.equal(
      validateCriteria({
        outcome_target: {
          goal: { kind: 'vendor_metric', vendor: { domain: 'measure.example' }, metric_id: 'attention_score' },
          volume: 10,
        },
      }),
      false,
    );
    assert.equal(
      validateCriteria({
        outcome_target: {
          goal: {
            kind: 'event',
            event_sources: [{ event_source_id: 'src_web_pixel', event_type: 'purchase' }],
          },
          volume: 10,
        },
      }),
      false,
    );
  });

  it('composes with the rest of the criteria object', () => {
    const criteria = {
      product_ids: ['product_premium_video'],
      outcome_target: {
        goal: { kind: 'metric', metric: 'clicks' },
        volume: 10000,
      },
    };
    assert.equal(validateCriteria(criteria), true, JSON.stringify(validateCriteria.errors));
  });
});
