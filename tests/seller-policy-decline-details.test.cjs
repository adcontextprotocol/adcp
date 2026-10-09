const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

async function loadSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8')
  );
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  return ajv.compileAsync(await loadSchema(uri));
}

test('seller policy decline vocabulary includes the Phase 1 reasons', async () => {
  const vocabulary = await loadSchema('/schemas/enums/seller-policy-decline-reason.json');
  assert.deepEqual(vocabulary.enum, [
    'inventory',
    'share_of_voice',
    'minimum_commitment',
    'notice_period',
    'contract_terms',
    'frequency_cap',
    'other',
  ]);
  assert.deepEqual(Object.keys(vocabulary.enumDescriptions), vocabulary.enum);

  const registry = await loadSchema('/schemas/index.json');
  assert.equal(
    registry.schemas.enums.schemas['seller-policy-decline-reason'].$ref,
    '/schemas/enums/seller-policy-decline-reason.json'
  );

  const errorCodes = await loadSchema('/schemas/enums/error-code.json');
  assert.match(errorCodes.enumDescriptions.REQUOTE_REQUIRED, /error-details\/requote-required\.json/);
  assert.match(errorCodes.enumDescriptions.REQUOTE_REQUIRED, /buyer-safe/);
  assert.match(errorCodes.enumDescriptions.ACTION_NOT_ALLOWED, /decline_reason/);
});

test('REQUOTE_REQUIRED details accept typed policy context and legacy envelope-field form', async () => {
  const validate = await compile('/schemas/error-details/requote-required.json');
  const details = {
    envelope_field: ['packages[0].budget', 'end_time'],
    change_term_id: 'right_increase_budget',
    decline_reason: 'share_of_voice',
  };

  assert.equal(validate(details), true, JSON.stringify(validate.errors));
  assert.equal(validate({ envelope_field: 'total_budget.amount' }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...details, decline_reason: 'internal_threshold_42' }), false);
  assert.equal(validate({ ...details, envelope_field: [] }), false);
});

test('ACTION_NOT_ALLOWED details accept an optional seller policy decline reason', async () => {
  const validate = await compile('/schemas/error-details/action-not-allowed.json');
  const details = {
    attempted_action: 'increase_budget',
    reason: 'not_supported_on_buy',
    currently_available_actions: [],
    decline_reason: 'contract_terms',
  };

  assert.equal(validate(details), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...details, decline_reason: 'seller_secret' }), false);
});
