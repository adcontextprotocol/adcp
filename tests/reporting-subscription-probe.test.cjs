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
const { generatedSchemaDocuments } = require('../scripts/task-responses.cjs');

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
// The schema build generates each task's response from its status bodies.
for (const schema of generatedSchemaDocuments(SCHEMAS).values()) ajv.addSchema(structuredClone(schema));
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

test('set_account_timezone returns SetAccountTimezoneResult', () => {
  const cutover = { offering_id: 'analytics_daily_api', previous_timezone: 'America/New_York', timezone: 'America/Los_Angeles', effective_at: '2030-11-05T05:00:00Z' };
  const result = simulated => ({ status: 'completed', success: true, simulated });
  const changed = {
    simulated_now: '2030-11-04T18:00:00Z',
    account_id: 'acc_sandbox',
    previous_timezone: 'America/New_York',
    timezone: 'America/Los_Angeles',
    changed_at: '2030-11-04T18:00:00Z',
    timezone_cutovers: [cutover],
  };
  assert.ok(response(result(changed)), JSON.stringify(response.errors));
  // Naming the current zone changes nothing: no changed_at, no cutover.
  const unchanged = { simulated_now: '2030-11-05T18:00:00Z', account_id: 'acc_sandbox', previous_timezone: 'America/Los_Angeles', timezone: 'America/Los_Angeles', timezone_cutovers: [] };
  assert.ok(response(result(unchanged)), JSON.stringify(response.errors));
  const { changed_at: _changedAt, ...withoutChangedAt } = changed;
  const bad = [
    ['without account_id', (({ account_id: _a, ...rest }) => rest)(changed)],
    ['without timezone', (({ timezone: _t, ...rest }) => rest)(changed)],
    ['without timezone_cutovers', (({ timezone_cutovers: _c, ...rest }) => rest)(withoutChangedAt)],
    ['a cutover without offering_id', { ...changed, timezone_cutovers: [(({ offering_id: _o, ...rest }) => rest)(cutover)] }],
    ['a cutover without previous_timezone', { ...changed, timezone_cutovers: [(({ previous_timezone: _p, ...rest }) => rest)(cutover)] }],
    ['a cutover with a field coverage does not define', { ...changed, timezone_cutovers: [{ ...cutover, changed_at: '2030-11-04T18:00:00Z' }] }],
    ['changed_at that is not an instant', { ...changed, changed_at: 'yesterday' }],
  ];
  for (const [name, simulated] of bad) assert.equal(response(result(simulated)), false, name);

  const res = read('compliance/comply-test-controller-completed.json');
  const def = res.definitions.SetAccountTimezoneResult;
  assert.equal(def['x-added-in'], '3.3.0');
  assert.equal(def['x-status'], 'experimental');
  const doc = fs.readFileSync(path.join(ROOT, 'docs/building/by-layer/L3/comply-test-controller.mdx'), 'utf8');
  assert.match(doc, /`set_account_timezone` returns `SetAccountTimezoneResult`/);
});

test('reset_state resets the probe clock and probe state', () => {
  const req = read('compliance/comply-test-controller-request.json');
  assert.match(req.properties.scenario.description, /a seller that lists reporting_subscription_probe MUST also list reset_state, which MUST unpin the caller's sandbox clock/);
  const doc = fs.readFileSync(path.join(ROOT, 'docs/building/by-layer/L3/comply-test-controller.mdx'), 'utf8');
  assert.match(doc, /### `reset_state`/);
  assert.match(doc, /A seller that lists `reporting_subscription_probe` MUST also\s+list `reset_state`/);
  assert.match(doc, /unpin the sandbox clock\. Until the next `advance_time`, `simulated_now` reads the\s+seller's wall clock/);
  // A reset returns the SeedSuccess shape.
  assert.ok(response({ status: 'completed', success: true }), JSON.stringify(response.errors));
});
