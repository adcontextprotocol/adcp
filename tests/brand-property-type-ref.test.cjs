const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

async function compile(schemaId) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => {
      if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load: ${uri}`);
      return JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', '')), 'utf8'));
    }
  });
  addFormats(ajv);
  return ajv.compileAsync(JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', '')), 'utf8')));
}

const ALL_PROPERTY_TYPES = [
  'website', 'mobile_app', 'ctv_app', 'desktop_app', 'dooh',
  'podcast', 'radio', 'linear_tv', 'streaming_audio', 'ai_assistant'
];

test('brand.json accepts all property types from enums/property-type.json', async () => {
  const validate = await compile('/schemas/brand.json');
  for (const pt of ALL_PROPERTY_TYPES) {
    const brand = {
      id: 'test_brand',
      names: [{ en: 'Test Brand' }],
      properties: [{
        type: pt,
        identifier: 'test.example'
      }]
    };
    assert.equal(validate(brand), true, `brand.json rejects property type "${pt}": ${JSON.stringify(validate.errors)}`);
  }
});

test('brand.json rejects invalid property type', async () => {
  const validate = await compile('/schemas/brand.json');
  const brand = {
    id: 'test_brand',
    names: [{ en: 'Test Brand' }],
    properties: [{
      type: 'invalid_type',
      identifier: 'test.example'
    }]
  };
  assert.equal(validate(brand), false);
});

test('verify-brand-claim-request accepts linear_tv and ai_assistant property types', async () => {
  const validate = await compile('/schemas/brand/verify-brand-claim-request.json');
  for (const pt of ['linear_tv', 'ai_assistant']) {
    const request = {
      claim_type: 'property',
      claim: {
        property: { type: pt, identifier: 'test.example' }
      }
    };
    assert.equal(validate(request), true, `verify-brand-claim-request rejects "${pt}": ${JSON.stringify(validate.errors)}`);
  }
});

test('verify-brand-claims-request accepts linear_tv and ai_assistant property types', async () => {
  const validate = await compile('/schemas/brand/verify-brand-claims-request.json');
  for (const pt of ['linear_tv', 'ai_assistant']) {
    const request = {
      claims: [{
        claim_type: 'property',
        claim: {
          property: { type: pt, identifier: 'test.example' }
        }
      }]
    };
    assert.equal(validate(request), true, `verify-brand-claims-request rejects "${pt}": ${JSON.stringify(validate.errors)}`);
  }
});
