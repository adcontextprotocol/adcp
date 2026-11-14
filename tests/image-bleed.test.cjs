const assert = require('node:assert/strict');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

const readSchema = (relativePath) => readBuiltSchema(`/schemas/${relativePath}`);

async function compile() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => readSchema(uri.replace('/schemas/', '')),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema('core/requirements/image-asset-requirements.json'));
}

const errors = (validate) => JSON.stringify(validate.errors, null, 2);
const withBleed = (bleed) => ({ bleed });

test('bleed is either one uniform value or all four sides', async () => {
  const validate = await compile();
  assert.equal(validate(withBleed({ uniform: 2 })), true, errors(validate));
  assert.equal(validate(withBleed({ top: 1, right: 1, bottom: 1, left: 1 })), true, errors(validate));
  assert.equal(validate(withBleed({})), false, 'one form is required');
  assert.equal(validate(withBleed({ top: 1, right: 1 })), false, 'the per-side form needs all four sides');
  assert.equal(validate(withBleed({ uniform: -1 })), false, 'bleed is not negative');
});

test('the uniform and per-side bleed forms exclude each other', async () => {
  const validate = await compile();
  assert.equal(validate(withBleed({ uniform: 2, top: 1 })), false, 'uniform with one side');
  assert.equal(validate(withBleed({ uniform: 2, top: 1, right: 1, bottom: 1, left: 1 })), false, 'per-side form plus uniform');
});

test('an unknown key on bleed validates', async () => {
  const validate = await compile();
  // Open by default (WG decision of 2026-11-09, DR-0036): an unknown key validates.
  assert.equal(validate(withBleed({ uniform: 2, note: 'x' })), true, errors(validate));
  assert.equal(validate(withBleed({ top: 1, right: 1, bottom: 1, left: 1, note: 'x' })), true, errors(validate));
});
