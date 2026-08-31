const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const SCHEMA_DIR = path.join(__dirname, '../static/schemas/source');

function schema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relativePath), 'utf8'));
}

test('buyer reason uses the comprehensive standard error-code vocabulary', () => {
  const vocabulary = schema('enums/error-code.json');
  for (const code of [
    'POLICY_VIOLATION',
    'GOVERNANCE_DENIED',
    'ACCOUNT_SETUP_REQUIRED',
    'BUDGET_TOO_LOW',
    'PRODUCT_UNAVAILABLE',
    'CREATIVE_SIZE_MISMATCH',
    'CREATIVE_MISSING_CLICK_URL',
    'CREATIVE_VALIDATION_FAILED_GENERIC',
  ]) {
    assert.ok(vocabulary.enum.includes(code), `${code} is absent from error-code.json`);
    assert.ok(vocabulary.enumDescriptions[code].length > 0);
    assert.ok(vocabulary.enumMetadata[code].suggestion.length > 0);
  }
});

test('core error accepts standard and forward-compatible buyer reason codes', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema('core/error.json'));
  const base = {
    code: 'CREATIVE_REJECTED',
    message: 'The creative could not be accepted.',
    recovery: 'correctable',
  };

  assert.equal(validate({
    ...base,
    buyer_reason: {
      code: 'CREATIVE_SIZE_MISMATCH',
      message: 'The creative dimensions do not match an accepted size.',
    },
  }), true, JSON.stringify(validate.errors));

  assert.equal(validate({
    ...base,
    buyer_reason: {
      code: 'X_VENDOR_FUTURE_BUYER_ACTION',
      message: 'Update the buyer-controlled input and retry.',
    },
  }), true, JSON.stringify(validate.errors));
});

test('core error requires a complete buyer reason', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema('core/error.json'));
  assert.equal(validate({
    code: 'CREATIVE_REJECTED',
    message: 'The creative could not be accepted.',
    recovery: 'correctable',
    buyer_reason: { code: 'CREATIVE_MISSING_CLICK_URL' },
  }), false);
});

test('core error requires recovery only when buyer reason is present', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema('core/error.json'));

  assert.equal(validate({
    code: 'CREATIVE_REJECTED',
    message: 'The creative could not be accepted.',
  }), true, JSON.stringify(validate.errors));

  assert.equal(validate({
    code: 'CREATIVE_REJECTED',
    message: 'The creative could not be accepted.',
    buyer_reason: {
      code: 'CREATIVE_SIZE_MISMATCH',
      message: 'The creative dimensions do not match an accepted size.',
    },
  }), false);
});
