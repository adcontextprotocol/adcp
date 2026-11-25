'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const { addNamedScalarSchemas } = require('./helpers/named-scalar-schemas.cjs');

const file = 'error-details/budget-too-low.json';
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../static/schemas/source', file), 'utf8'));
const validate = addNamedScalarSchemas(new Ajv({ allErrors: true, strict: false })).compile(schema);

function documentationExamples() {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/building/by-layer/L3/error-handling.mdx'), 'utf8');
  return Array.from(doc.matchAll(/```json[^\n]*\n([\s\S]*?)```/g))
    .filter(match => match[1].includes('"$schema"'))
    .map(match => JSON.parse(match[1]));
}

test('legacy budget details keep undeclared periods and seller-specific context', () => {
  for (const details of [{}, { minimum_budget: 500, currency: 'GBP' }, { seller_floor: 'campaign' }]) {
    assert.equal(validate(details), true, JSON.stringify(validate.errors));
    assert.equal(Object.hasOwn(details, 'basis'), false);
  }
});

test('daily bid floors distinguish the constrained amount from the contributing bid', () => {
  const details = {
    minimum_budget: 30,
    currency: 'GBP',
    budget_field: 'packages[0].daily_budget_cap',
    basis: 'daily',
    constraint: 'effective_bid_floor',
    related_field: 'packages[0].bidding.bid_amount',
  };
  assert.equal(validate(details), true, JSON.stringify(validate.errors));
  const withoutRequestField = { ...details };
  delete withoutRequestField.related_field;
  assert.equal(validate(withoutRequestField), true, JSON.stringify(validate.errors));
  assert.equal(validate({ minimum_budget: 500, currency: 'GBP', basis: 'lifetime', constraint: 'product_minimum' }), true);
});

test('bid is a constraint cause, not a budget period', () => {
  assert.equal(validate({ minimum_budget: 30, currency: 'GBP', basis: 'bid' }), false);
  assert.ok(validate.errors.some(error => error.instancePath === '/basis'));
  assert.equal(validate({ basis: 'daily', constraint: 'seller_campaign_floor' }), true);
});

test('typed recovery fields reject malformed values', () => {
  for (const details of [
    { minimum_budget: '30' },
    { basis: null },
    { basis: 7 },
    { constraint: '' },
    { constraint: [] },
    { budget_field: '' },
    { budget_field: ['packages[0].daily_budget_cap'] },
    { related_field: '' },
    { related_field: ['packages[0].bidding.bid_amount'] },
  ]) {
    assert.equal(validate(details), false, JSON.stringify(details));
  }
});

test('documented budget errors validate their details separately from the open error wrapper', () => {
  const errorSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../static/schemas/source/core/error.json'), 'utf8'));
  const validateError = addNamedScalarSchemas(new Ajv({ allErrors: true, strict: false })).compile(errorSchema);
  const errors = documentationExamples().filter(example => example.code === 'BUDGET_TOO_LOW');
  assert.ok(errors.some(error => error.details.basis === 'lifetime'));
  assert.ok(errors.some(error => error.details.constraint === 'effective_bid_floor'));
  for (const error of errors) {
    assert.equal(validateError(error), true, JSON.stringify(validateError.errors));
    assert.equal(validate(error.details), true, JSON.stringify(validate.errors));
  }

  const invalid = structuredClone(errors.find(error => error.details.constraint === 'effective_bid_floor'));
  invalid.details.basis = 'bid';
  assert.equal(validateError(invalid), true, 'the generic error wrapper deliberately leaves details open');
  assert.equal(validate(invalid.details), false, 'the recommended budget contract rejects bid as a period');
});

test('documented bid-only update keeps its issue pointer separate from the retained budget locator', () => {
  const examples = documentationExamples();
  const row = examples.find(example => example.$schema.endsWith('/media-buy/package-control.json'));
  const error = examples.find(example => example.details?.constraint === 'effective_bid_floor');
  assert.ok(row.package_id, 'the submitted row identifies the existing package');
  assert.equal(Object.hasOwn(row, 'daily_budget_cap'), false, 'the daily cap is retained');
  assert.equal(error.field, 'packages[0].bidding.bid_amount');
  assert.equal(error.issues[0].pointer, '/packages/0/bidding/bid_amount');
  assert.equal(error.details.related_field, error.field);
  assert.equal(error.details.budget_field, 'packages[0].daily_budget_cap');
  assert.notEqual(error.details.budget_field, error.field);
  assert.equal(error.details.minimum_budget, row.bidding.bid_amount);

  const diagnostic = { ...error.details };
  delete diagnostic.budget_field;
  assert.equal(validate(diagnostic), true, 'an unlocatable budget remains valid diagnostic context');
});
