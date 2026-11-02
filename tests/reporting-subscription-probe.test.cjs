'use strict';

/**
 * comply_test_controller scenario reporting_subscription_probe (experimental,
 * media_buy.reporting_subscriptions): grant, timezone, and clock operations so
 * storyboards can test reporting-subscription coverage against a remote seller.
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

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.json')) {
      const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
    }
  }
})(SCHEMAS);
const request = ajv.getSchema('/schemas/compliance/comply-test-controller-request.json');
const response = ajv.getSchema('/schemas/compliance/comply-test-controller-response.json');
const call = params => ({ scenario: 'reporting_subscription_probe', account: { sandbox: true }, params });

test('each operation carries exactly its parameters', () => {
  const ok = [
    { operation: 'revoke_grant', account_id: 'acc_sandbox' },
    { operation: 'regrant', account_id: 'acc_sandbox' },
    { operation: 'reduce_grant', account_id: 'acc_sandbox', allowed_tasks: ['get_reporting_status', 'sync_reporting_receipts', 'sync_reporting_status'] },
    { operation: 'set_account_timezone', account_id: 'acc_sandbox', timezone: 'America/Los_Angeles' },
    { operation: 'advance_time', target_time: '2026-11-04T05:00:00Z' },
  ];
  for (const params of ok) assert.ok(request(call(params)), `${params.operation}: ${JSON.stringify(request.errors)}`);
  const bad = [
    ['revoke without an account', { operation: 'revoke_grant' }],
    ['reduce without allowed_tasks', { operation: 'reduce_grant', account_id: 'acc_sandbox' }],
    ['reduce to nothing', { operation: 'reduce_grant', account_id: 'acc_sandbox', allowed_tasks: [] }],
    ['allowed_tasks on another operation', { operation: 'regrant', account_id: 'acc_sandbox', allowed_tasks: ['get_reporting_status'] }],
    ['timezone change without a zone', { operation: 'set_account_timezone', account_id: 'acc_sandbox' }],
    ['timezone on another operation', { operation: 'revoke_grant', account_id: 'acc_sandbox', timezone: 'UTC' }],
    ['advance without a target', { operation: 'advance_time' }],
    ['an operation of another probe', { operation: 'publish_zero_row', account_id: 'acc_sandbox' }],
  ];
  for (const [name, params] of bad) assert.equal(request(call(params)), false, name);
});

test('results are simulation responses and the scenario is documented', () => {
  const res = { status: 'completed', success: true, simulated: { simulated_now: '2026-11-20T09:00:00Z', account_id: 'acc_sandbox', unauthorized_at: '2026-11-20T09:00:00Z' } };
  assert.ok(response(res), JSON.stringify(response.errors));
  const req = read('compliance/comply-test-controller-request.json');
  assert.match(req.properties.scenario.description, /'reporting_subscription_probe' \(experimental, media_buy\.reporting_subscriptions\)/);
  for (const k of ['allowed_tasks', 'timezone']) {
    assert.equal(req.properties.params.properties[k]['x-status'], 'experimental', k);
    assert.equal(req.properties.params.properties[k]['x-added-in'], '3.3.0', k);
  }
  const doc = fs.readFileSync(path.join(ROOT, 'docs/building/by-layer/L3/comply-test-controller.mdx'), 'utf8');
  for (const op of ['revoke_grant', 'regrant', 'reduce_grant', 'set_account_timezone', 'advance_time']) assert.match(doc, new RegExp(`\\*\\*${op}\\*\\*`), op);
  assert.match(doc, /only on the authenticated caller's own\ngrant/);
});
