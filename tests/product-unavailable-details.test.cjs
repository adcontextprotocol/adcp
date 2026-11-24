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
  package_field: 'purchases[0]',
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
    package_field: 'purchases[1]',
    product_id: 'prod_2',
    availability_status: 'available',
    unit: 'impressions',
    requested: 100000,
    bookable: 250000,
  }));
  ok('forecast_unavailable entry without unit or numbers', wrap(refused({ reason: 'forecast_unavailable' })));
  ok('fixed-price refusal reported by max_budget alone, without delivery figures', wrap(refused({
    max_budget: { amount: 500, currency: 'EUR', pricing_option_id: 'po_cpm_fixed' },
  })));
  ok('package_id alone locates an existing package listed for headroom', wrap({
    package_id: 'pkg_9',
    product_id: 'prod_2',
    availability_status: 'available',
    unit: 'impressions',
    requested: 100000,
    bookable: 250000,
  }));
  ok('package_field and package_id together', wrap(refused({ package_id: 'pkg_1' })));
  ok('whole impressions', wrap(refused({ unit: 'impressions', requested: 50000, bookable: 36377 })));
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

  bad('unavailable without reason', wrap({ package_field: 'purchases[0]', product_id: 'p', availability_status: 'unavailable' }));
  bad('available with reason', wrap({ package_field: 'purchases[0]', product_id: 'p', availability_status: 'available', reason: 'over_forecast' }));
  bad('unavailable entry with no package locator', wrap({ product_id: 'p', availability_status: 'unavailable', reason: 'over_forecast' }));
  bad('available entry with no package locator', wrap({ product_id: 'p', availability_status: 'available' }));
  bad('fractional impressions requested', wrap(refused({ unit: 'impressions', requested: 10.25 })));
  bad('fractional impressions bookable', wrap(refused({ unit: 'impressions', bookable: 3.75 })));
  bad('fractional clicks bookable', wrap(refused({ unit: 'clicks', bookable: 0.5 })));
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
  bad('missing product_id', wrap({ package_field: 'purchases[0]', availability_status: 'unavailable', reason: 'over_forecast' }));
  bad('missing availability_status', wrap({ package_field: 'purchases[0]', product_id: 'p' }));
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
    assert.equal(error.mutation_outcome, 'not_applied', 'pre-write refusals carry mutation_outcome not_applied');
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

function workedExample() {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/building/by-layer/L3/error-handling.mdx'), 'utf8');
  const start = doc.indexOf('**Example: a six-package video buy.**');
  assert.ok(start >= 0, 'worked example heading is present');
  const rows = new Map();
  for (const line of doc.slice(start).split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    const field = cells[1] && cells[1].match(/^`(purchases\[\d+\])`$/);
    if (cells.length > 6 && field) {
      rows.set(field[1], {
        product: cells[2].replace(/`/g, ''),
        cpm: Number(cells[3]),
        budget: Number(cells[4].replace(/,/g, '')),
        impressions: Number(cells[5].replace(/,/g, '')),
      });
    } else if (rows.size && line.startsWith('```')) {
      break;
    }
  }
  assert.equal(rows.size, 6, 'six purchase rows parsed from the worked-example table');
  const example = documentationExamples().find(
    e => e.code === 'PRODUCT_UNAVAILABLE' && e.details.packages.length > 2
  );
  assert.ok(example, 'worked example JSON is present');
  return { rows, example };
}

const floorCents = value => Math.floor(value * 100) / 100;
const cents = value => Math.round(value * 100) / 100;

function checkWorkedExample({ rows, example }) {
  for (const [field, row] of rows) {
    assert.equal(cents((row.impressions * row.cpm) / 1000), row.budget, `${field}: table budget matches impressions at CPM`);
  }
  const byField = new Map();
  for (const entry of example.details.packages) {
    const row = rows.get(entry.package_field);
    assert.ok(row, `${entry.package_field} is a row in the table`);
    byField.set(entry.package_field, entry);
    assert.equal(entry.product_id, row.product, `${entry.package_field}: product matches table`);
    assert.equal(entry.requested, row.impressions, `${entry.package_field}: requested matches table impressions`);
    assert.equal(
      entry.max_budget.amount,
      floorCents((entry.bookable * row.cpm) / 1000),
      `${entry.package_field}: max_budget is bookable at the table CPM, rounded down`
    );
  }

  // Cutting the two refused purchases frees budget that moves onto the two with headroom.
  const freed = cents(rows.get('purchases[1]').budget - byField.get('purchases[1]').max_budget.amount
    + rows.get('purchases[3]').budget - byField.get('purchases[3]').max_budget.amount);
  assert.equal(freed, 342.35);
  assert.equal(cents(204.35 + 138.0), freed, 'moved amount equals freed amount');
  assert.ok(rows.get('purchases[0]').budget + 204.35 <= byField.get('purchases[0]').max_budget.amount);
  assert.ok(rows.get('purchases[4]').budget + 138.0 <= byField.get('purchases[4]').max_budget.amount);
}

test('documented worked example agrees with its rate table and reallocation narrative', () => {
  checkWorkedExample(workedExample());
});

test('worked-example check catches a tampered max_budget', () => {
  const { rows, example } = workedExample();
  const tampered = structuredClone(example);
  tampered.details.packages.find(e => e.product_id === 'ctv_primetime_30s').max_budget.amount = 1920;
  assert.throws(() => checkWorkedExample({ rows, example: tampered }), /max_budget/);
});
