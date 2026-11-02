'use strict';

/**
 * notification-config product_payload_view has no schema-level default (#8313).
 *
 * A seller whose response model materializes schema defaults must not turn an
 * account-only subscription into a schema-invalid one when it echoes the
 * config on sync_accounts or list_accounts.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMAS = path.resolve(__dirname, '../static/schemas/source');
const loadSchema = async uri =>
  JSON.parse(fs.readFileSync(path.join(SCHEMAS, uri.replace('/schemas/', '')), 'utf8'));

async function compile(uri, options = {}) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema, ...options });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

const ACCOUNT_ONLY = {
  subscriber_id: 'change-feed',
  url: 'https://buyer.example/webhooks/adcp/accounts',
  event_types: ['account.change_recorded'],
  active: true,
};

test('product_payload_view declares no schema default', async () => {
  const schema = await loadSchema('/schemas/core/notification-config.json');
  assert.equal('default' in schema.properties.product_payload_view, false);
});

test('product_payload_view is accepted only alongside a product.* event', async () => {
  const validate = await compile('/schemas/core/notification-config.json');
  assert.equal(validate(ACCOUNT_ONLY), true);
  assert.equal(validate({ ...ACCOUNT_ONLY, product_payload_view: 'legacy' }), false);
  assert.equal(validate({ ...ACCOUNT_ONLY, product_payload_view: 'canonical' }), false);
  assert.equal(
    validate({ ...ACCOUNT_ONLY, event_types: ['product.updated'], product_payload_view: 'legacy' }),
    true
  );
});

test('a default-materializing seller echoes an account-only config that stays valid', async () => {
  const fillDefaults = await compile('/schemas/core/notification-config.json', { useDefaults: true });
  const validateListAccounts = await compile('/schemas/account/list-accounts-response.json');

  const echoed = structuredClone(ACCOUNT_ONLY);
  fillDefaults(echoed);
  assert.equal('product_payload_view' in echoed, false);

  const response = {
    status: 'completed',
    accounts: [{ account_id: 'acct_acme', name: 'Acme', status: 'active', notification_configs: [echoed] }],
  };
  assert.equal(validateListAccounts(response), true, JSON.stringify(validateListAccounts.errors));
});
