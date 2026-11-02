'use strict';

/**
 * Schema contract for experimental account requests (account.requests, #8280):
 * request_account (open or change), list_accounts requests, the account_request.changed webhook,
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
    { ...base, state: 'resolved', account_id: 'acc_1', resolution: 'matched', account: { account_id: 'acc_1', name: 'Matched account', status: 'active', billing: 'operator', payment_terms: 'net_30' } },
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
  assert.match(kind.description, /MUST accept unknown values/);
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
        read_task: 'list_accounts',
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
    '/schemas/core/account-request-record.json',
    '/schemas/core/pending-action.json',
    '/schemas/core/account-request-changed-webhook.json',
  ]) {
    assert.ok(index.includes(id), `${id} is in index.json`);
  }
});

test('task request schemas are experimental and added in 3.3.0', () => {
  for (const file of ['account/request-account-request.json']) {
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

test('request_account changes an account by account_id and resolves as updated', () => {
  const req = read('account/request-account-request.json');
  assert.ok(req.properties.revision, 'revision guards a change');
  assert.match(req.properties.revision.description, /Required when the change touches billing, billing_entity, or payment_terms/);
  assert.match(req.properties.account_id.description, /changes those attributes/);
  assert.ok(read('enums/account-request-resolution.json').enum.includes('updated'));
  const v = validate('/schemas/core/account-request-record.json');
  const account = { account_id: 'acc_1', name: 'Nova NL', status: 'active', revision: 8 };
  const change = {
    request_id: 'areq_change_1',
    requested: { account_id: 'acc_1', revision: 7, brand: { domain: 'nova.example', countries: ['BE', 'NL'] } },
    created_at: '2026-10-28T09:00:00Z',
    updated_at: '2026-10-28T09:00:00Z',
  };
  assert.ok(v({ ...change, state: 'resolved', account_id: 'acc_1', resolution: 'updated', account }), JSON.stringify(v.errors));
  assert.ok(v({ ...change, state: 'in_review', pending_action: { waiting_on: 'seller', kind: 'review', message: 'Market review.' } }), JSON.stringify(v.errors));
  assert.equal(v({ ...change, state: 'in_review', account, pending_action: { waiting_on: 'seller', kind: 'review', message: 'x' } }), false, 'no account snapshot while pending');
});

test('a change request can resolve to a separate or existing account, leaving the named one untouched', () => {
  const resolution = read('enums/account-request-resolution.json');
  assert.match(resolution.enumDescriptions.created, /On a change request, the seller opened a separate account/);
  assert.match(resolution.enumDescriptions.matched, /On a change request, the seller pointed to an account the caller already holds/);
  assert.match(read('core/account-request-record.json').properties.account_id.description, /different account from requested\.account_id/);
  const v = validate('/schemas/core/account-request-record.json');
  const change = {
    request_id: 'areq_change_2',
    requested: { account_id: 'acc_nova_europe', brand: { domain: 'nova-athletics.example', countries: ['NL'] } },
    created_at: '2026-10-29T09:00:00Z',
    updated_at: '2026-10-29T09:00:00Z',
  };
  const separate = { account_id: 'acc_nova_nl_2', name: 'Nova Athletics NL', status: 'active', revision: 1 };
  assert.ok(v({ ...change, state: 'resolved', account_id: 'acc_nova_nl_2', resolution: 'created', account: separate, not_carried_over: [] }), JSON.stringify(v.errors));
  assert.ok(v({ ...change, state: 'resolved', account_id: 'acc_nova_nl', resolution: 'matched', account: { account_id: 'acc_nova_nl', name: 'Nova Athletics NL', status: 'active' } }), JSON.stringify(v.errors));
});

test('a separate account on a change is opt-in; otherwise the seller rejects with ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT', () => {
  const req = read('account/request-account-request.json');
  assert.equal(req.properties.allow_separate_account.type, 'boolean');
  assert.equal(req.properties.allow_separate_account.default, false);
  assert.match(req.properties.allow_separate_account.description, /ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT/);
  assert.match(read('enums/account-request-resolution.json').enumDescriptions.created, /only when the change request set allow_separate_account: true/);
  const codes = read('enums/error-code.json');
  assert.ok(codes.enum.includes('ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT'));
  assert.equal(codes.enumMetadata.ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT.recovery, 'correctable');
  const rowDescription = read('account/sync-accounts-response.json').oneOf[0].properties.accounts.items.properties.request_id.description;
  assert.match(rowDescription, /never resolves as created/);
  const vReq = validate('/schemas/account/request-account-request.json');
  const change = { adcp_version: '3.3', idempotency_key: '7b0c8a4e-1f2d-4e6a-9c3b-5d8e2f1a6b70', account_id: 'acc_nova_europe', brand: { domain: 'nova-athletics.example', countries: ['NL'] }, allow_separate_account: true };
  assert.ok(vReq(change), JSON.stringify(vReq.errors));
  const vRec = validate('/schemas/core/account-request-record.json');
  const refused = {
    request_id: 'areq_change_3',
    state: 'rejected',
    requested: { account_id: 'acc_nova_europe', brand: { domain: 'nova-athletics.example', countries: ['NL'] } },
    errors: [{ code: 'ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT', message: 'NL needs a separate Dutch contract.' }],
    created_at: '2026-10-29T09:00:00Z',
    updated_at: '2026-10-29T09:00:00Z',
  };
  assert.ok(vRec(refused), JSON.stringify(vRec.errors));
});

test('a sync_accounts settings-update row under review carries the request_id', () => {
  const res = read('account/sync-accounts-response.json');
  const rowSchema = res.oneOf[0].properties.accounts.items;
  assert.match(rowSchema.properties.request_id.description, /On a settings-update row whose change the seller is reviewing/);
  assert.match(rowSchema.properties.request_id.description, /MUST include it/);
  const v = validate('/schemas/account/sync-accounts-response.json');
  const row = {
    account: { account_id: 'acc_nova_pinnacle' },
    action: 'unchanged',
    status: 'pending_approval',
    request_id: 'areq_nova_be_market',
    setup: { message: 'Adding BE requires a market review.' },
  };
  assert.ok(v({ status: 'completed', accounts: [row] }), JSON.stringify(v.errors));
  assert.equal(v({ status: 'completed', accounts: [{ ...row, status: 'active' }] }), false, 'request_id only while pending_approval');
});

test('list_accounts returns the caller\'s requests; get_account_requests is gone', () => {
  const req = read('account/list-accounts-request.json');
  assert.ok(req.properties.include_requests && req.properties.request_ids && req.properties.requests_pagination);
  assert.ok(read('account/list-accounts-response.json').properties.account_requests_pagination, 'requests page independently of accounts');
  const v = validate('/schemas/account/list-accounts-response.json');
  const request = { request_id: 'areq_1', state: 'in_review', requested: { brand: { domain: 'nova.example' }, operator: 'pinnacle.example' }, pending_action: { waiting_on: 'seller', kind: 'review', message: 'Reviewing.' }, created_at: '2026-10-28T09:00:00Z', updated_at: '2026-10-28T09:00:00Z' };
  assert.ok(v({ status: 'completed', accounts: [], account_requests: [request] }), JSON.stringify(v.errors));
  assert.equal(fs.existsSync(path.join(SCHEMAS, 'account/get-account-requests-request.json')), false);
  assert.equal(JSON.stringify(read('index.json')).includes('get-account-requests'), false);
});

test('sync_accounts stays stable, and subscription-only entries never provision', () => {
  const sync = read('account/sync-accounts-request.json');
  assert.equal(sync['x-deprecated-in'], undefined, 'not machine-deprecated while account.requests is experimental');
  assert.match(sync.description, /stays stable and available in 3\.3/);
  assert.match(sync.description, /subscription write: it MUST name an account the caller already holds/);
});

test('request_account change mode is authorized, reachability-first, and continues open requests', () => {
  const req = read('account/request-account-request.json');
  assert.ok(req.properties.request_id, 'request_id continues an open request');
  assert.match(req.description, /answers an unreachable account exactly as an unknown one, before any other validation/);
  assert.match(req.description, /SCOPE_INSUFFICIENT, READ_ONLY_SCOPE, or FIELD_NOT_PERMITTED/);
  assert.match(req.description, /re-checks revision when it resolves/);
  const caps = read('protocol/get-adcp-capabilities-response.json').properties.account.properties.requests.oneOf[0].properties;
  assert.ok(caps.changeable_attributes, 'sellers declare which attributes they change');
});

// Account follow-ups (3.3.0-beta.3).
test('matched and created resolutions carry the target account and its money terms', () => {
  const record = read('core/account-request-record.json');
  assert.match(record.properties.account.description, /When resolution is matched or created, sellers MUST include it, with the account's money terms/);
  const v = validate('/schemas/core/account-request-record.json');
  const target = { account_id: 'acc_nova_pinnacle', name: 'Nova Athletics via Pinnacle Media', status: 'active', billing: 'operator', payment_terms: 'net_45' };
  for (const resolution of ['matched', 'created']) {
    assert.ok(v({ ...base, state: 'resolved', account_id: 'acc_nova_pinnacle', resolution, account: target }), JSON.stringify(v.errors));
    assert.equal(v({ ...base, state: 'resolved', account_id: 'acc_nova_pinnacle', resolution }), false, `${resolution} without account`);
  }
  for (const example of record.examples) assert.ok(v(example.data), example.description);
  const response = validate('/schemas/account/request-account-response.json');
  for (const example of read('account/request-account-response.json').examples) assert.ok(response(example.data), example.description);
});

test('money changes carry effective_at; a separate account lists what did not carry over', () => {
  const record = read('core/account-request-record.json');
  assert.equal(record.properties.effective_at['x-added-in'], '3.3.0');
  assert.equal(record.properties.not_carried_over['x-added-in'], '3.3.0');
  assert.deepEqual(record.properties.not_carried_over.items.enum, ['notification_configs', 'reporting_delivery_configs', 'reporting_bucket', 'governance_agents', 'creatives', 'audiences', 'catalogs', 'event_sources']);
  const v = validate('/schemas/core/account-request-record.json');
  const account = { account_id: 'acc_nova', name: 'Nova', status: 'active', revision: 8, payment_terms: 'net_60' };
  const money = { request_id: 'areq_money', requested: { account_id: 'acc_nova', revision: 7, payment_terms: 'net_60' }, created_at: '2026-10-28T09:00:00Z', updated_at: '2026-10-28T09:00:00Z', state: 'resolved', account_id: 'acc_nova', resolution: 'updated', account };
  assert.ok(v({ ...money, effective_at: '2026-11-01T00:00:00Z' }), JSON.stringify(v.errors));
  assert.equal(v(money), false, 'a money change needs effective_at');
  const countries = { ...money, requested: { account_id: 'acc_nova', brand: { domain: 'nova-athletics.example', countries: ['NL'] } } };
  assert.ok(v(countries), JSON.stringify(v.errors));
  assert.equal(v({ ...countries, effective_at: '2026-11-01T00:00:00Z' }), false, 'effective_at only on money changes');

  const separate = { request_id: 'areq_sep', requested: { account_id: 'acc_nova', brand: { domain: 'nova-athletics.example', countries: ['NL'] } }, created_at: '2026-10-28T09:00:00Z', updated_at: '2026-10-28T09:00:00Z', state: 'resolved', account_id: 'acc_nova_nl', resolution: 'created', account: { account_id: 'acc_nova_nl', name: 'Nova NL', status: 'active' } };
  assert.ok(v({ ...separate, not_carried_over: ['reporting_delivery_configs', 'governance_agents'] }), JSON.stringify(v.errors));
  assert.equal(v(separate), false, 'a separate account says what did not carry over');
  assert.equal(v({ ...separate, requested: { brand: { domain: 'nova-athletics.example' }, operator: 'pinnacle-media.example' }, not_carried_over: [] }), false, 'not on an open request');
});

test('timezone is changeable only where changeable_attributes lists it', () => {
  const caps = read('protocol/get-adcp-capabilities-response.json').properties.account.properties.requests.oneOf[0].properties.changeable_attributes;
  assert.ok(caps.items.enum.includes('timezone'));
  assert.match(caps.description, /a seller that changes an account's timezone through request_account MUST list timezone/);
  assert.match(read('account/request-account-request.json').description, /currency and timezone change only on sellers that list them in account\.requests\.changeable_attributes/);
  const doc = fs.readFileSync(path.join(ROOT, 'docs/accounts/tasks/request_account.mdx'), 'utf8');
  assert.doesNotMatch(doc, /The changeable attributes are those \[#8474\]/);
  assert.match(doc, /change only on a seller that lists them/);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs/protocol/sync_principal.mdx'), 'utf8'), /on a seller that lists `timezone` in `account\.requests\.changeable_attributes`/);
});
