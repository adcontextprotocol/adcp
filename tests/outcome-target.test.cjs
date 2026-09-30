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

  it('requires a goal plus at least one of volume or cost_per', () => {
    assert.equal(validateCriteria({ outcome_target: { volume: 10000 } }), false);
    assert.equal(
      validateCriteria({ outcome_target: { cost_per: { amount: 3, currency: 'USD', strength: 'cap' } } }),
      false,
    );
    assert.equal(
      validateCriteria({ outcome_target: { goal: { kind: 'metric', metric: 'clicks' } } }),
      false,
    );
  });

  it('accepts a cost_per target alone, alongside a budget range, or with a volume', () => {
    const goal = { kind: 'metric', metric: 'clicks' };
    const cost_per = { amount: 3, currency: 'EUR', strength: 'cap' };
    for (const criteria of [
      { outcome_target: { goal, cost_per } },
      { offer_filters: { budget_range: { max: 5000, currency: 'EUR' } }, outcome_target: { goal, cost_per } },
      { outcome_target: { goal, volume: 1500, cost_per: { ...cost_per, strength: 'target' } } },
      { outcome_target: { goal: { kind: 'event', event_type: 'purchase' }, cost_per: { amount: 45.5, currency: 'USD', strength: 'target' } } },
    ]) {
      assert.equal(validateCriteria(criteria), true, `${JSON.stringify(criteria)}: ${JSON.stringify(validateCriteria.errors)}`);
    }
  });

  it('requires amount, currency, and strength on cost_per and nothing else', () => {
    const goal = { kind: 'metric', metric: 'clicks' };
    for (const cost_per of [
      { amount: 3, strength: 'cap' },
      { currency: 'USD', strength: 'cap' },
      { amount: 3, currency: 'USD' },
      { amount: 0, currency: 'USD', strength: 'cap' },
      { amount: 3, currency: 'usd', strength: 'cap' },
      { amount: 3, currency: 'USD', strength: 'floor' },
      { amount: 3, currency: 'USD', strength: 'cap', max_bid: 5 },
    ]) {
      assert.equal(validateCriteria({ outcome_target: { goal, cost_per } }), false, JSON.stringify(cost_per));
    }
  });

  it('pins cost_per.strength to the BiddingPolicy.cost_per strength vocabulary', () => {
    // Separate schemas give generated SDKs distinct type names
    // (OutcomeTargetCostPer, OutcomeTargetCostStrength) rather than a second
    // CostPer/Strength colliding with BiddingPolicy's; this pins the values.
    const outcomeTarget = readSchema('/schemas/media-buy/outcome-target.json');
    assert.equal(outcomeTarget.properties.cost_per.$ref, '/schemas/core/outcome-target-cost-per.json');
    const costPer = readSchema('/schemas/core/outcome-target-cost-per.json');
    assert.equal(costPer.properties.strength.$ref, '/schemas/enums/outcome-target-cost-strength.json');
    const outcomeStrengths = readSchema('/schemas/enums/outcome-target-cost-strength.json').enum;
    const biddingStrengths = readSchema('/schemas/core/bidding-policy.json').properties.cost_per.properties.strength.enum;
    assert.deepEqual(outcomeStrengths, biddingStrengths);
  });

  it('keeps the deprecated optimization-goal target shape out of outcome_target', () => {
    assert.equal(
      validateCriteria({
        outcome_target: { goal: { kind: 'metric', metric: 'clicks' }, target: { kind: 'cost_per', value: 3 } },
      }),
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
