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

  it('accepts a vendor_metric goal with a volume, a cost_per target, or both', () => {
    const goal = { kind: 'vendor_metric', vendor: { domain: 'footfallvendor.example' }, metric_id: 'store_visits_14d_exposed' };
    for (const outcome_target of [
      { goal, volume: 5000 },
      { goal, cost_per: { amount: 4, currency: 'USD', strength: 'cap' } },
      { goal, volume: 5000, cost_per: { amount: 4, currency: 'USD', strength: 'target' } },
      { goal: { ...goal, vendor: { domain: 'measure.example', brand_id: 'panel' } }, volume: 1 },
    ]) {
      assert.equal(validateCriteria({ outcome_target }), true, `${JSON.stringify(outcome_target)}: ${JSON.stringify(validateCriteria.errors)}`);
    }
  });

  it('requires vendor and metric_id on a vendor_metric goal and nothing else', () => {
    const vendor = { domain: 'footfallvendor.example' };
    for (const goal of [
      { kind: 'vendor_metric', metric_id: 'store_visits_14d_exposed' },
      { kind: 'vendor_metric', vendor },
      { kind: 'vendor_metric', vendor: {}, metric_id: 'store_visits_14d_exposed' },
      { kind: 'vendor_metric', vendor, metric_id: 'store_visits_14d_exposed', target: { kind: 'threshold_rate', value: 70 } },
      { kind: 'vendor_metric', vendor, metric_id: 'store_visits_14d_exposed', metric: 'clicks' },
    ]) {
      assert.equal(validateCriteria({ outcome_target: { goal, volume: 10 } }), false, JSON.stringify(goal));
    }
    assert.equal(
      validateCriteria({
        outcome_target: { goal: { kind: 'vendor_metric', vendor, metric_id: 'store_visits_14d_exposed' } },
      }),
      false,
      'a vendor goal still needs a volume or a cost_per',
    );
  });

  it('uses the canonical optimization-goal vendor key for the vendor_metric goal', () => {
    // Plan, buy and delivery reconcile on one (vendor, metric_id) pair, so the
    // planning goal must reference the same identity schemas.
    const goal = readSchema('/schemas/media-buy/outcome-target.json').properties.goal.oneOf
      .find(branch => branch.properties.kind.const === 'vendor_metric');
    const optimizationGoal = readSchema('/schemas/core/canonical-optimization-goal.json').oneOf
      .find(branch => branch.properties.kind.const === 'vendor_metric');
    assert.equal(goal.properties.vendor.$ref, optimizationGoal.properties.vendor.$ref);
    assert.equal(goal.properties.metric_id.$ref, optimizationGoal.properties.metric_id.$ref);
    assert.equal(goal['x-added-in'], '3.3.0');
  });

  it('answers a vendor_metric goal on a canonical forecast point in vendor_metric_values', async () => {
    const validatePoint = await compile(readSchema('/schemas/core/canonical-forecast-point.json'));
    const point = {
      budget: 5000,
      metrics: { spend: { mid: 4980 } },
      vendor_metric_values: [{
        vendor: { domain: 'footfallvendor.example' },
        metric_id: 'store_visits_14d_exposed',
        value: { low: 4200, mid: 5000, high: 5600 },
        unit: 'visits',
      }],
    };
    assert.equal(validatePoint(point), true, JSON.stringify(validatePoint.errors));
    // The vendor metric is not a metrics key: metrics keys are
    // forecastable-metric and event-type values, so a ForecastRange-valued
    // vendor key there would be indistinguishable from a seller-native metric.
    const forecastable = readSchema('/schemas/enums/forecastable-metric.json').enum;
    assert.equal(forecastable.includes('store_visits_14d_exposed'), false);
  });

  it('keeps threshold_rate and per_ad_spend out of outcome_target', () => {
    // Deferred past 3.3: planning semantics for threshold_rate are undecided
    // and per_ad_spend needs event-scoped value delivery does not carry.
    const goal = { kind: 'metric', metric: 'clicks' };
    for (const field of ['threshold_rate', 'per_ad_spend']) {
      assert.equal(validateCriteria({ outcome_target: { goal, volume: 10, [field]: { value: 0.5 } } }), false, field);
    }
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
