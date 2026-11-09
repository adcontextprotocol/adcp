const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

const readSchema = (relativePath) => JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, relativePath), 'utf8'));

async function compile() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => readSchema(uri.replace('/schemas/', '')),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema('core/canonical-account-ref.json'));
}

const errors = (validate) => JSON.stringify(validate.errors, null, 2);
const BRAND = { domain: 'nova-athletics.example' };
const OPERATOR = 'nova-athletics.example';

test('a canonical account ref is an account_id or the brand + operator natural key', async () => {
  const validate = await compile();
  assert.equal(validate({ account_id: 'acc_nova_nl' }), true, errors(validate));
  assert.equal(validate({ brand: BRAND, operator: OPERATOR }), true, errors(validate));
  assert.equal(validate({}), false, 'one of the two forms is required');
  assert.equal(validate({ brand: BRAND }), false, 'the natural key needs an operator');
});

test('the account_id form names no natural-key member, and the natural key names no account_id', async () => {
  const validate = await compile();
  assert.equal(validate({ account_id: 'acc_nova_nl', brand: BRAND }), false, 'brand beside account_id');
  assert.equal(validate({ account_id: 'acc_nova_nl', operator: OPERATOR }), false, 'operator beside account_id');
  assert.equal(validate({ account_id: 'acc_nova_nl', brand: BRAND, operator: OPERATOR }), false, 'both forms at once');
});

test('an unknown key on a canonical account ref validates', async () => {
  const validate = await compile();
  // Open by default (WG decision of 2026-11-09, DR-0009): an unknown key validates.
  assert.equal(validate({ account_id: 'acc_nova_nl', note: 'x' }), true, errors(validate));
  assert.equal(validate({ brand: BRAND, operator: OPERATOR, note: 'x' }), true, errors(validate));
});
