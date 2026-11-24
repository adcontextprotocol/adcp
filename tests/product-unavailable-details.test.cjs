'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');
const DETAILS_URI = '/schemas/error-details/product-unavailable.json';

async function loadSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  return ajv.compileAsync(await loadSchema(uri));
}

function documentationExamples() {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/building/by-layer/L3/error-handling.mdx'), 'utf8');
  return Array.from(doc.matchAll(/```json[^\n]*\n([\s\S]*?)```/g))
    .filter(match => match[1].includes('"$schema"'))
    .map(match => JSON.parse(match[1]));
}

const refused = (extra = {}) => ({
  product_id: 'prod_1',
  availability_status: 'unavailable',
  reason: 'over_forecast',
  ...extra,
});
const wrap = (...packages) => ({ packages });

test('valid details', async t => {
  const validate = await compile(DETAILS_URI);
  const ok = (name, details) =>
    t.test(name, () => assert.equal(validate(details), true, JSON.stringify(validate.errors)));

  ok('minimal refused entry', wrap(refused()));
  ok('full over_forecast entry with bookable above available.mid', wrap(refused({
    package_field: 'purchases[0]',
    package_id: 'pkg_1',
    unit: 'impressions',
    requested: 1000000,
    available: { low: 400000, mid: 600000, high: 800000 },
    bookable: 700000,
    max_budget: { amount: 10500, currency: 'USD', pricing_option_id: 'po_cpm' },
  })));
  ok('headroom entry without reason', wrap({
    product_id: 'prod_2',
    availability_status: 'available',
    unit: 'impressions',
    requested: 100000,
    bookable: 250000,
  }));
  ok('forecast_unavailable entry without unit or numbers', wrap(refused({ reason: 'forecast_unavailable' })));
  ok('budget-only entry with max_budget and no unit', wrap(refused({
    max_budget: { amount: 500, currency: 'EUR', pricing_option_id: 'po_flat' },
  })));
  ok('fractional grps', wrap(refused({ unit: 'grps', requested: 12.5, bookable: 10.25 })));
  ok('unknown extra keys at every level', {
    extra_top: 1,
    packages: [refused({
      extra_entry: true,
      unit: 'clicks',
      available: { mid: 5, extra_range: 1 },
      max_budget: { amount: 1, currency: 'USD', pricing_option_id: 'p', extra_budget: 'x' },
    })],
  });
});

test('invalid details', async t => {
  const validate = await compile(DETAILS_URI);
  const bad = (name, details) => t.test(name, () => assert.equal(validate(details), false));
  const budget = { amount: 1, currency: 'USD', pricing_option_id: 'po' };

  bad('unavailable without reason', wrap({ product_id: 'p', availability_status: 'unavailable' }));
  bad('available with reason', wrap({ product_id: 'p', availability_status: 'available', reason: 'over_forecast' }));
  bad('unknown reason', wrap(refused({ reason: 'sold_out' })));
  bad('unknown unit', wrap(refused({ unit: 'eyeballs' })));
  bad('money unit spend', wrap(refused({ unit: 'spend', requested: 1 })));
  bad('requested without unit', wrap(refused({ requested: 10 })));
  bad('bookable without unit', wrap(refused({ bookable: 10 })));
  bad('available without unit', wrap(refused({ available: { mid: 10 } })));
  bad('max_budget missing pricing_option_id', wrap(refused({ max_budget: { amount: 1, currency: 'USD' } })));
  bad('max_budget missing amount', wrap(refused({ max_budget: { currency: 'USD', pricing_option_id: 'po' } })));
  bad('max_budget lowercase currency', wrap(refused({ max_budget: { ...budget, currency: 'usd' } })));
  bad('negative bookable', wrap(refused({ unit: 'impressions', bookable: -1 })));
  bad('negative requested', wrap(refused({ unit: 'impressions', requested: -1 })));
  bad('empty packages', { packages: [] });
  bad('missing packages', {});
  bad('missing product_id', wrap({ availability_status: 'unavailable', reason: 'over_forecast' }));
  bad('missing availability_status', wrap({ product_id: 'p' }));
  bad('empty package_field', wrap(refused({ package_field: '' })));
  bad('empty package_id', wrap(refused({ package_id: '' })));
  bad('available range with neither mid nor low+high', wrap(refused({ unit: 'impressions', available: { low: 1 } })));
  bad('available range empty', wrap(refused({ unit: 'impressions', available: {} })));
});

test('error-code contract', async () => {
  const schema = await loadSchema(DETAILS_URI);
  const codes = await loadSchema('/schemas/enums/error-code.json');
  assert.match(codes.enumDescriptions.PRODUCT_UNAVAILABLE, /error-details\/product-unavailable\.json/);
  assert.equal(codes.enumMetadata.PRODUCT_UNAVAILABLE.recovery, 'correctable');
  assert.equal(schema['x-added-in'], '4.0.0');

  const props = schema.properties.packages.items.properties;
  assert.equal(props.package_id['x-entity'], 'package');
  assert.equal(props.product_id['x-entity'], 'product');
  assert.equal(props.max_budget.properties.pricing_option_id['x-entity'], 'product_pricing_option');
});

test('documented PRODUCT_UNAVAILABLE examples validate and are numerically coherent', async () => {
  const validateError = await compile('/schemas/core/error.json');
  const validateDetails = await compile(DETAILS_URI);
  const errors = documentationExamples().filter(example => example.code === 'PRODUCT_UNAVAILABLE');
  assert.ok(errors.length > 0, 'error-handling.mdx has a $schema-tagged PRODUCT_UNAVAILABLE example');

  const entries = [];
  for (const error of errors) {
    assert.equal(validateError(error), true, JSON.stringify(validateError.errors));
    assert.equal(validateDetails(error.details), true, JSON.stringify(validateDetails.errors));
    entries.push(...error.details.packages);
  }

  const overForecast = entries.filter(e => e.availability_status === 'unavailable' && e.reason === 'over_forecast');
  const headroom = entries.filter(e => e.availability_status === 'available');
  assert.ok(overForecast.length > 0, 'an over_forecast entry is documented');
  assert.ok(headroom.length > 0, 'an available headroom entry is documented');

  for (const e of overForecast) {
    assert.ok(e.requested > e.bookable, `${e.product_id}: requested ${e.requested} must exceed bookable ${e.bookable}`);
  }
  for (const e of headroom) {
    assert.ok(e.requested <= e.bookable, `${e.product_id}: requested ${e.requested} must not exceed bookable ${e.bookable}`);
  }
});

test('documented recovery is transient only when every refused package is forecast_unavailable', () => {
  const errors = documentationExamples().filter(example => example.code === 'PRODUCT_UNAVAILABLE');
  let transient = 0;
  let correctable = 0;
  for (const error of errors) {
    const refusals = error.details.packages.filter(e => e.availability_status === 'unavailable');
    const allForecastUnavailable = refusals.length > 0 && refusals.every(e => e.reason === 'forecast_unavailable');
    assert.equal(error.recovery, allForecastUnavailable ? 'transient' : 'correctable', error.message);
    if (allForecastUnavailable) transient++;
    else correctable++;
  }
  assert.ok(transient > 0, 'a transient example is documented');
  assert.ok(correctable > 0, 'a correctable example is documented');
});

test('documented max_budget round-trips from bookable at the implied CPM', () => {
  const entries = documentationExamples()
    .filter(example => example.code === 'PRODUCT_UNAVAILABLE')
    .flatMap(error => error.details.packages)
    .filter(e => e.max_budget && e.unit === 'impressions' && e.bookable);
  assert.ok(entries.length > 0, 'a documented entry carries impressions, bookable and max_budget');
  for (const e of entries) {
    const cpm = Math.round((e.max_budget.amount / e.bookable) * 1000 * 100) / 100;
    assert.equal(
      Math.floor(((e.bookable * cpm) / 1000) * 100) / 100,
      e.max_budget.amount,
      `${e.product_id}: max_budget ${e.max_budget.amount} is not bookable ${e.bookable} at ${cpm} CPM`
    );
  }
});
