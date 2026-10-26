'use strict';

/**
 * Schema contract for experimental account requests (account.requests, #8280):
 * request_account, get_account_requests, the account_request.changed webhook,
 * and the sync_accounts projection fields.
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

const requested = {
  brand: { domain: 'renault.fr', countries: ['FR'] },
  operator: 'wppmedia.fr',
  currency: 'EUR',
  billing: 'operator',
};
const base = {
  request_id: 'areq_01K4F8M2Q7',
  requested,
  created_at: '2026-10-18T09:00:00Z',
  updated_at: '2026-10-18T09:00:00Z',
};
const sellerReview = { waiting_on: 'seller', kind: 'review', message: 'Checking existing records.' };
const candidates = [
  { account_id: 'act_1', name: 'Renault FR (1)' },
  { account_id: 'act_2', name: 'Renault FR (2)' },
];

test('each request state carries exactly its own fields', () => {
  const v = validate('/schemas/core/account-request-record.json');
  const ok = [
    { ...base, state: 'in_review', pending_action: sellerReview },
    { ...base, state: 'resolved', account_id: 'acc_1', resolution: 'matched' },
    { ...base, state: 'ambiguous', candidates },
    { ...base, state: 'rejected', errors: [{ code: 'POLICY_VIOLATION', message: 'Category not accepted.' }] },
  ];
  for (const doc of ok) assert.ok(v(doc), `${doc.state} validates: ${JSON.stringify(v.errors)}`);

  const bad = [
    ['in_review without pending_action', { ...base, state: 'in_review' }],
    ['in_review with an account_id', { ...base, state: 'in_review', pending_action: sellerReview, account_id: 'acc_1' }],
    ['resolved without resolution', { ...base, state: 'resolved', account_id: 'acc_1' }],
    ['resolved still carrying a pending action', { ...base, state: 'resolved', account_id: 'acc_1', resolution: 'created', pending_action: sellerReview }],
    ['ambiguous without candidates', { ...base, state: 'ambiguous' }],
    ['ambiguous with one candidate', { ...base, state: 'ambiguous', candidates: candidates.slice(0, 1) }],
    ['rejected without errors', { ...base, state: 'rejected' }],
    ['rejected with an account_id', { ...base, state: 'rejected', account_id: 'acc_1', errors: [{ code: 'X', message: 'x' }] }],
  ];
  for (const [name, doc] of bad) assert.equal(v(doc), false, `${name} is rejected`);
});

test('a buyer-side pending action needs an https URL', () => {
  const v = validate('/schemas/core/pending-action.json');
  assert.ok(v(sellerReview), 'seller review needs no URL');
  assert.equal(v({ waiting_on: 'buyer', kind: 'sign_up', message: 'Register.' }), false, 'buyer action without url');
  assert.equal(
    v({ waiting_on: 'buyer', kind: 'sign_up', message: 'Register.', url: 'http://seller.example/register' }),
    false,
    'plain http URL'
  );
  assert.ok(v({ waiting_on: 'buyer', kind: 'sign_up', message: 'Register.', url: 'https://seller.example/register' }));
});

test('pending-action kinds are extensible', () => {
  const kind = read('enums/pending-action-kind.json');
  assert.equal(kind['x-extensible'], true);
  for (const value of kind.enum) assert.ok(kind.enumDescriptions[value], `${value} is described`);
});

test('request_account response wraps the request and keeps failures separate', () => {
  const v = validate('/schemas/account/request-account-response.json');
  assert.ok(v({ status: 'completed', request: { ...base, state: 'in_review', pending_action: sellerReview } }), JSON.stringify(v.errors));
  assert.equal(v({ status: 'completed' }), false, 'completed without request');
});

test('request_account input stays a plain root object for MCP', () => {
  const schema = read('account/request-account-request.json');
  for (const keyword of ['oneOf', 'anyOf', 'if', 'not']) assert.equal(schema[keyword], undefined, `no top-level ${keyword}`);
  assert.deepEqual(schema.required, ['idempotency_key']);
  for (const key of ['brand', 'operator', 'operator_unit', 'currency', 'timezone', 'sandbox', 'account_id']) {
    assert.ok(schema.properties[key], `${key} is accepted`);
  }
});

test('a sync_accounts pending row may carry request_id instead of account_id', () => {
  const v = validate('/schemas/account/sync-accounts-response.json');
  const row = {
    brand: { domain: 'renault.fr' },
    operator: 'wppmedia.fr',
    action: 'created',
    status: 'pending_approval',
    request_id: 'areq_01K4F8M2Q7',
    setup: { message: 'Under review.', waiting_on: 'seller', kind: 'review' },
  };
  assert.ok(v({ status: 'completed', accounts: [row] }), JSON.stringify(v.errors));
  const matched = { brand: { domain: 'renault.fr' }, operator: 'wppmedia.fr', action: 'unchanged', status: 'active', account_id: 'acc_1', resolution: 'matched' };
  assert.ok(v({ status: 'completed', accounts: [matched] }), JSON.stringify(v.errors));

  assert.equal(v({ status: 'completed', accounts: [{ ...row, account_id: 'acc_1' }] }), false, 'request_id beside account_id');
  assert.equal(v({ status: 'completed', accounts: [{ ...row, status: 'active' }] }), false, 'request_id on an active row');
  const { account_id: _omit, ...unresolved } = matched;
  assert.equal(v({ status: 'completed', accounts: [unresolved] }), false, 'resolution without account_id');
});

test('account.requests capability requires the experimental feature id', () => {
  const v = validate('/schemas/protocol/get-adcp-capabilities-response.json');
  const caps = {
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    account: {
      supported_billing: ['operator'],
      requests: {
        supported: true,
        request_task: 'request_account',
        read_task: 'get_account_requests',
        event_type: 'account_request.changed',
      },
    },
  };
  const errorsFor = doc => (v(doc) ? [] : v.errors).filter(e => /experimental_features/.test(`${e.instancePath} ${e.params && e.params.missingProperty}`));
  assert.ok(errorsFor(caps).length > 0, 'missing account.requests feature id is rejected');
  assert.deepEqual(errorsFor({ ...caps, experimental_features: ['account.requests'] }), [], 'listing the feature id satisfies the conditional');
  const unsupported = read('protocol/get-adcp-capabilities-response.json').properties.account.properties.requests;
  assert.equal(unsupported['x-status'], 'experimental');
});

test('account_request.changed is a caller-anchored event type', () => {
  assert.ok(read('enums/notification-type.json').enum.includes('account_request.changed'));
  const accountAnchored = read('core/agent-notification-config.json').if.properties.event_types.contains.enum;
  assert.equal(accountAnchored.includes('account_request.changed'), false, 'no all_authorized_accounts acknowledgment needed');
  const accountLevel = read('core/notification-config.json').properties.event_types.items.enum;
  assert.equal(accountLevel.includes('account_request.changed'), false, 'not an account-level subscription');

  const v = validate('/schemas/core/agent-notification-config.json');
  assert.ok(v({ subscriber_id: 'buyer-events', url: 'https://buyer.example/hooks', event_types: ['account_request.changed'] }), JSON.stringify(v.errors));

  const hook = validate('/schemas/core/account-request-changed-webhook.json');
  for (const example of read('core/account-request-changed-webhook.json').examples) {
    assert.ok(hook(example.data), JSON.stringify(hook.errors));
  }
});

test('new schemas are registered in the index', () => {
  const index = JSON.stringify(read('index.json'));
  for (const id of [
    '/schemas/account/request-account-request.json',
    '/schemas/account/request-account-response.json',
    '/schemas/account/get-account-requests-request.json',
    '/schemas/account/get-account-requests-response.json',
    '/schemas/core/account-request-record.json',
    '/schemas/core/pending-action.json',
    '/schemas/core/account-request-changed-webhook.json',
  ]) {
    assert.ok(index.includes(id), `${id} is in index.json`);
  }
});

test('task request schemas are experimental and added in 3.3.0', () => {
  for (const file of ['account/request-account-request.json', 'account/get-account-requests-request.json']) {
    const schema = read(file);
    assert.equal(schema['x-status'], 'experimental', file);
    assert.equal(schema['x-added-in'], '3.3.0', file);
  }
});

test('request_account deduplication is guidance, and terms are not account identity', () => {
  const schema = read('account/request-account-request.json');
  assert.doesNotMatch(schema.description, /deduplicate per authenticated caller/);
  for (const term of ['billing', 'billing_entity', 'payment_terms']) {
    assert.match(schema.properties[term].description, /not account identity/, term);
  }
  for (const attribute of ['currency', 'timezone', 'sandbox']) {
    assert.match(schema.properties[attribute].description, /account attribute/, attribute);
  }
});

test('list_accounts guidance keeps the account_scope SHOULD and no preference order', () => {
  const description = read('account/list-accounts-response.json').properties.accounts.description;
  assert.match(description, /SHOULD return account_scope/);
  assert.match(description, /no preference order/);
});
