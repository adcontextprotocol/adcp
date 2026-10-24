'use strict';

/**
 * Schema contract for experimental account updates (account.updates, #8280):
 * update_account and brand countries reconciliation (#8442).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const read = file => JSON.parse(fs.readFileSync(path.join(SCHEMAS, file), 'utf8'));

function loadAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
      }
    }
  };
  walk(SCHEMAS);
  return ajv;
}

const ajv = loadAjv();
const validate = id => {
  const fn = ajv.getSchema(id);
  assert.ok(fn, `schema ${id} is registered`);
  return fn;
};

test('update_account input stays a plain root object for MCP', () => {
  const schema = read('account/update-account-request.json');
  for (const keyword of ['oneOf', 'anyOf', 'if', 'not', 'dependencies']) {
    assert.equal(schema[keyword], undefined, `no top-level ${keyword}`);
  }
  assert.deepEqual(schema.required, ['idempotency_key', 'account']);
  assert.equal(schema['x-added-in'], undefined, 'task request schemas stay unmarked');
  for (const key of ['revision', 'operator_identity', 'destination_billing_entity', 'brand_identity', 'billing_entity', 'payment_terms', 'notification_configs', 'dry_run']) {
    assert.ok(schema.properties[key], `${key} is accepted`);
  }
  const v = validate('/schemas/account/update-account-request.json');
  for (const example of schema.examples) assert.ok(v(example.data), JSON.stringify(v.errors));
});

test('update_account response carries the account and an outcome', () => {
  const v = validate('/schemas/account/update-account-response.json');
  for (const example of read('account/update-account-response.json').examples) {
    assert.ok(v(example.data), JSON.stringify(v.errors));
  }
  const account = { account_id: 'acc_1', name: 'A', status: 'active', revision: 2 };
  assert.equal(v({ status: 'completed', account }), false, 'completed without outcome');
  assert.equal(v({ status: 'completed', outcome: 'merged', account }), false, 'unknown outcome');
  assert.ok(v({ status: 'completed', outcome: 'unchanged', account }), JSON.stringify(v.errors));
});

test('brand_identity is a settings-update field on sync_accounts and needs revision', () => {
  const v = validate('/schemas/account/sync-accounts-request.json');
  const base = { idempotency_key: '0b6c9f2e-4d1a-4a7e-8c3b-5f2d7e9a1c40' };
  const update = { account: { account_id: 'acc_1' }, revision: 3, brand_identity: { domain: 'renault.fr', countries: ['BE', 'FR'] } };
  assert.ok(v({ ...base, accounts: [update] }), JSON.stringify(v.errors));
  const { revision: _r, ...noRevision } = update;
  assert.equal(v({ ...base, accounts: [noRevision] }), false, 'brand_identity without revision');
  const provisioning = { brand: { domain: 'renault.fr' }, operator: 'wppmedia.fr', billing: 'operator', brand_identity: { domain: 'renault.fr' } };
  assert.equal(v({ ...base, accounts: [provisioning] }), false, 'brand_identity in provisioning mode');
});

test('identity changes keep requested_operator_identity required and add the brand', () => {
  const v = validate('/schemas/core/account-identity-change.json');
  const op = { operator: 'wppmedia.fr' };
  const brand = { domain: 'renault.fr', countries: ['BE', 'FR'] };
  assert.ok(v({ status: 'pending_approval', requested_operator_identity: op, requested_brand_identity: brand, pending_action: { waiting_on: 'seller', kind: 'review', message: 'Reviewing.' } }), JSON.stringify(v.errors));
  assert.equal(v({ status: 'pending_approval', requested_brand_identity: brand }), false, '3.2 consumers still get requested_operator_identity');
  const preview = validate('/schemas/core/account-identity-change-preview.json');
  assert.ok(preview({ outcome: 'would_require_approval', requested_operator_identity: op, requested_brand_identity: brand, impacts: [{ area: 'billing', effect: 'revalidation_required' }] }), JSON.stringify(preview.errors));
});

test('capabilities: brand_countries and account.updates require the feature id', () => {
  const v = validate('/schemas/protocol/get-adcp-capabilities-response.json');
  const errorsFor = doc => (v(doc) ? [] : v.errors).filter(e => /experimental_features/.test(`${e.instancePath} ${e.params && e.params.missingProperty}`));
  const base = { adcp: { major_versions: [3] }, supported_protocols: ['media_buy'] };
  const updates = { ...base, account: { supported_billing: ['operator'], updates: { supported: true, update_task: 'update_account' } } };
  const countries = { ...base, account: { supported_billing: ['operator'], identity_updates: { supported: true, supported_changes: ['brand_countries'] } } };
  for (const doc of [updates, countries]) {
    assert.ok(errorsFor(doc).length > 0, 'missing account.updates is rejected');
    assert.deepEqual(errorsFor({ ...doc, experimental_features: ['account.updates'] }), []);
  }
  const changes = read('protocol/get-adcp-capabilities-response.json').properties.account.properties.identity_updates.oneOf[0].properties.supported_changes.items.enum;
  assert.ok(changes.includes('brand_countries'));
});

test('update_account is registered for the 3.3 media-buy line and as mutating', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/build-schemas.cjs'), 'utf8'), /'3\.3\.0': \[[^\]]*'update_account'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'server/src/training-agent/idempotency.ts'), 'utf8'), /'update_account'/);
  assert.ok(JSON.stringify(read('index.json')).includes('/schemas/account/update-account-request.json'));
});
