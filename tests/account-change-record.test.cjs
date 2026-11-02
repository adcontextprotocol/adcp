const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');

function readSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema('/schemas/core/account-change.json'));
}

const KEY = '9f2c1d7e-3b5a-4c68-8e10-a7d4b2f6c901';

const record = (overrides = {}) => ({
  change_id: 'chg_01K38H2R5D7B0V9N3C4S8E6J1P',
  recorded_at: '2026-10-12T12:04:19Z',
  resource: { type: 'media_buy', account_id: 'acc_luma_shared', resource_id: 'mb_5512' },
  action: 'updated',
  origin: { kind: 'adcp' },
  changed_paths: ['/packages/0/budget'],
  repair: { task: 'get_media_buys' },
  ...overrides,
});

test('changed_paths is required and non-empty for adcp and seller_operator origins', async () => {
  const validate = await compile();
  for (const kind of ['adcp', 'seller_operator']) {
    assert.equal(validate(record({ origin: { kind } })), true, `${kind} with paths`);
    const { changed_paths: _omit, ...without } = record({ origin: { kind } });
    assert.equal(validate(without), false, `${kind} without paths must fail`);
    assert.equal(validate(record({ origin: { kind }, changed_paths: [] })), false, `${kind} with empty paths must fail`);
    assert.equal(validate(record({ origin: { kind }, changed_paths: [''] })), true, `${kind} root pointer`);
  }
});

test('changed_paths stays best-effort for seller_system, connected_platform, and unknown origins', async () => {
  const validate = await compile();
  for (const kind of ['seller_system', 'connected_platform', 'unknown']) {
    const { changed_paths: _omit, ...without } = record({ origin: { kind } });
    assert.equal(validate(without), true, `${kind} without paths`);
    assert.equal(validate(record({ origin: { kind } })), true, `${kind} with paths`);
  }
});

test('idempotency_key is an optional echo valid only on adcp origin', async () => {
  const validate = await compile();
  assert.equal(validate(record()), true, 'optional on adcp');
  assert.equal(validate(record({ idempotency_key: KEY })), true, 'echoed on adcp');
  for (const kind of ['seller_operator', 'seller_system', 'connected_platform', 'unknown']) {
    assert.equal(validate(record({ origin: { kind }, idempotency_key: KEY })), false, `${kind} must not echo`);
  }
  assert.equal(validate(record({ idempotency_key: 'short' })), false, 'must match the request key grammar');
});

test('the idempotency_key property is marked as new in 3.3.0', () => {
  const property = readSchema('/schemas/core/account-change.json').properties.idempotency_key;
  assert.equal(property['x-added-in'], '3.3.0');
});

test('the wake-up notification schema carries no originating request key', () => {
  const webhook = readSchema('/schemas/core/account-change-recorded-webhook.json');
  assert.equal(webhook.properties.idempotency_key.description.startsWith('Sender-generated delivery key'), true);
  assert.equal(webhook.properties.origin, undefined);
});
