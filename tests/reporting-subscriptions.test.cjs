'use strict';

/**
 * Schema contract for experimental principal-level reporting subscriptions
 * (media_buy.reporting_subscriptions, RFC #8543 Part B): the sync_principal
 * reporting_subscriptions section and its readback, get_reporting_status
 * subscription_coverage, and the reporting_delivery capability additions.
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

const allAccounts = {
  subscription_id: 'analytics-daily',
  subscription_version: 1,
  active: true,
  scope: { all_authorized_accounts: true },
  selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'official', dimensions: ['package'] },
  reconciliation_mode: 'delivery_only',
  destination: { destination_id: 'reporting-archive', path_template: 'analytics/{account_id}/{period_start}' },
};

test('schema examples validate', () => {
  for (const [file, id] of [
    ['core/reporting-subscription.json', '/schemas/core/reporting-subscription.json'],
    ['core/reporting-subscription-coverage.json', '/schemas/core/reporting-subscription-coverage.json'],
  ]) {
    const v = validate(id);
    for (const example of read(file).examples) assert.ok(v(example.data), `${file}: ${example.description}: ${JSON.stringify(v.errors)}`);
  }
});

test('scope is exactly one of all_authorized_accounts or account_ids', () => {
  const v = validate('/schemas/core/reporting-subscription.json');
  assert.ok(v(allAccounts), JSON.stringify(v.errors));
  assert.ok(v({ ...allAccounts, scope: { account_ids: ['acc_1'] }, destination: { destination_id: 'nova-bucket' } }), JSON.stringify(v.errors));
  assert.equal(v({ ...allAccounts, scope: {} }), false, 'empty scope');
  assert.equal(v({ ...allAccounts, scope: { all_authorized_accounts: false } }), false, 'all-accounts is an explicit true');
  assert.equal(v({ ...allAccounts, scope: { all_authorized_accounts: true, account_ids: ['acc_1'] } }), false, 'both scopes');
});

test('exclude_account_ids only applies to an all-accounts subscription', () => {
  const v = validate('/schemas/core/reporting-subscription.json');
  assert.ok(v({ ...allAccounts, exclude_account_ids: ['acc_9'] }), JSON.stringify(v.errors));
  assert.equal(v({ ...allAccounts, scope: { account_ids: ['acc_1'] }, exclude_account_ids: ['acc_9'] }), false);
});

test('a multi-account path template must partition by {account_id}', () => {
  const v = validate('/schemas/core/reporting-subscription.json');
  const flat = { destination_id: 'reporting-archive', path_template: 'analytics/{period_start}' };
  assert.equal(v({ ...allAccounts, destination: flat }), false, 'all-accounts without {account_id}');
  assert.equal(v({ ...allAccounts, scope: { account_ids: ['acc_1', 'acc_2'] }, destination: flat }), false, 'two accounts without {account_id}');
  assert.ok(v({ ...allAccounts, scope: { account_ids: ['acc_1'] }, destination: flat }), 'one account may use a flat path');
  assert.equal(v({ ...allAccounts, destination: { destination_id: 'x', path_template: '/abs/{account_id}' } }), false, 'absolute path');
  assert.equal(v({ ...allAccounts, destination: { destination_id: 'x', path_template: '{account_id}/../up' } }), false, 'parent traversal');
});

test('selector requires stable attributes and closes match and dimensions', () => {
  const v = validate('/schemas/core/reporting-subscription.json');
  const { period_duration: _p, ...noPeriod } = allAccounts.selector;
  assert.equal(v({ ...allAccounts, selector: noPeriod }), false, 'period_duration required');
  assert.equal(v({ ...allAccounts, selector: { ...allAccounts.selector, match: 'coarsest' } }), false, 'unknown match');
  assert.ok(v({ ...allAccounts, selector: { ...allAccounts.selector, match: 'all' } }), JSON.stringify(v.errors));
  assert.equal(v({ ...allAccounts, selector: { ...allAccounts.selector, offering_id: 'daily' } }), false, 'no seller-specific offering_id');
  assert.equal(v({ ...allAccounts, selector: { ...allAccounts.selector, period_timezone: 'America/New_York' } }), false, 'no single timezone across accounts');
  assert.ok(
    v({ ...allAccounts, scope: { account_ids: ['acc_1'] }, selector: { ...allAccounts.selector, period_timezone: 'America/New_York' } }),
    JSON.stringify(v.errors)
  );
  assert.equal(
    v({ ...allAccounts, scope: { account_ids: ['acc_1', 'acc_2'] }, destination: { destination_id: 'x', path_template: '{account_id}' }, selector: { ...allAccounts.selector, period_timezone: 'America/New_York' } }),
    false,
    'period_timezone needs exactly one account'
  );
  const dims = read('enums/reporting-dimension.json');
  assert.deepEqual(dims.enum, ['package', 'creative', 'country', 'region', 'metro']);
  assert.equal(dims['x-extensible'], true);
  assert.match(dims.description, /MUST accept unknown values/);
});

test('billing subscriptions are official and receipt-reconciled', () => {
  const v = validate('/schemas/core/reporting-subscription.json');
  const billing = { ...allAccounts, selector: { feed_purpose: 'billing', period_duration: 'P1M', required_finality: 'official' }, reconciliation_mode: 'consumer_receipt' };
  assert.ok(v(billing), JSON.stringify(v.errors));
  assert.equal(v({ ...billing, reconciliation_mode: 'delivery_only' }), false, 'billing without receipts');
  assert.equal(v({ ...billing, selector: { ...billing.selector, required_finality: 'snapshot' } }), false, 'billing snapshots');
  const { destination: _d, ...apiOnly } = billing;
  assert.equal(v(apiOnly), false, 'consumer_receipt needs a managed destination');
});

test('sync_principal accepts the section and get_principal reads it back', () => {
  const request = validate('/schemas/protocol/sync-principal-request.json');
  assert.ok(request({ idempotency_key: 'c6a0f1e2-1d0b-4d8e-9a65-0f9b3c2e7a11', configuration: { reporting_subscriptions: [allAccounts] } }), JSON.stringify(request.errors));
  assert.ok(request({ idempotency_key: 'c6a0f1e2-1d0b-4d8e-9a65-0f9b3c2e7a12', configuration: { reporting_subscriptions: [] } }), '[] deactivates all');
  const schema = read('protocol/sync-principal-request.json');
  for (const keyword of ['oneOf', 'anyOf', 'if', 'not']) assert.equal(schema[keyword], undefined, `no top-level ${keyword}`);
  assert.match(schema['x-adcp-validation'].reporting_subscriptions, /delivery_config_id/);

  const state = validate('/schemas/core/principal-state.json');
  const current = { subscription_id: 'analytics-daily', subscription_version: 1, state: 'active', accepted_at: '2026-11-01T00:00:00Z', destination_ref: 'dest_01', configuration: allAccounts };
  assert.ok(state({ reporting_subscriptions: [current] }), JSON.stringify(state.errors));
  assert.equal(state({ reporting_subscriptions: [{ ...current, state: 'action_required' }] }), false, 'action_required needs issues');
  assert.equal(state({ reporting_subscriptions: [{ ...current, state: 'inactive' }] }), false, 'inactive needs deactivated_at');
  assert.equal(state({ reporting_subscriptions: [{ ...current, deactivated_at: '2026-11-02T00:00:00Z' }] }), false, 'active with deactivated_at');

  const enumValues = read('protocol/get-adcp-capabilities-response.json').properties.adcp.properties.principal.properties.supported_sections.items.enum;
  assert.ok(enumValues.includes('reporting_subscriptions'));
});

test('lost authority is reported in the caller\'s own subscription state', () => {
  const state = validate('/schemas/core/reporting-subscription-state.json');
  const current = { subscription_id: 'analytics-daily', subscription_version: 1, state: 'active', accepted_at: '2026-11-01T00:00:00Z', configuration: allAccounts };
  const revoked = { account_id: 'acc_7', unauthorized_at: '2026-11-20T09:00:00Z', last_covered_until: '2026-11-20T05:00:00Z', withheld_period_count: 1, withheld_reporting_obligation_ids: ['obl_1'] };
  assert.ok(state({ ...current, accounts_unauthorized: [revoked] }), JSON.stringify(state.errors));
  const { withheld_period_count: _w, ...noCount } = revoked;
  assert.equal(state({ ...current, accounts_unauthorized: [noCount] }), false, 'withheld_period_count required');
  assert.equal(state({ ...current, accounts_unauthorized: [{ ...revoked, covered: [] }] }), false, 'no current account data');
  const caps = read('core/reporting-delivery-capabilities.json').properties.subscriptions.properties.backfill_on_regrant.description;
  assert.match(caps, /original covered_from/);
});

test('receipts and statuses stay acceptable after revocation for revisions already read', () => {
  for (const file of ['media-buy/sync-reporting-receipts-request.json', 'media-buy/sync-reporting-status-request.json']) {
    const rule = read(file)['x-adcp-validation'].after_revocation;
    assert.match(rule, /read before unauthorized_at/, file);
    assert.match(rule, /status_retention_days/, file);
    assert.match(rule, /unknown identifier/, file);
  }
});

test('sync_accounts delivery configs win over subscriptions and share the id namespace', () => {
  const description = read('account/sync-accounts-request.json').properties.accounts.items.properties.reporting_delivery_configs.description;
  assert.match(description, /subscription_id values MUST be rejected/);
  assert.match(description, /precedence over every reporting subscription/);
  assert.match(read('core/reporting-subscription.json')['x-adcp-validation'].precedence, /replaces every subscription, all-accounts or account_ids/);
});

const coverageBase = { subscription_id: 'analytics-daily', subscription_version: 1, covered: [], excluded: [] };

test('coverage status carries exactly its own fields', () => {
  const v = validate('/schemas/core/reporting-subscription-coverage.json');
  const review = { waiting_on: 'seller', kind: 'review', message: 'Capacity review.' };
  const ok = [
    { ...coverageBase, status: 'active' },
    { ...coverageBase, status: 'excluded', excluded: [{ reason: 'capacity' }] },
    { ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden', overridden_by: { delivery_config_id: 'acct-analytics' } }] },
    { ...coverageBase, status: 'action_required', pending_action: review },
  ];
  for (const doc of ok) assert.ok(v(doc), `${doc.status}: ${JSON.stringify(v.errors)}`);

  const bad = [
    ['unauthorized is not an account status here', { ...coverageBase, status: 'unauthorized' }],
    ['no unauthorized_at in coverage', { ...coverageBase, status: 'active', unauthorized_at: '2026-11-20T09:00:00Z' }],
    ['no withheld periods in coverage', { ...coverageBase, status: 'active', withheld_unauthorized: [] }],
    ['action_required without pending_action', { ...coverageBase, status: 'action_required' }],
    ['pending_action on an active account', { ...coverageBase, status: 'active', pending_action: review }],
    ['excluded without an account-level entry', { ...coverageBase, status: 'excluded', excluded: [{ media_buy_id: 'mb_1', reason: 'capacity' }] }],
    ['overridden without the overriding id', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden' }] }],
    ['overridden_by on another reason', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'capacity', overridden_by: { subscription_id: 's' } }] }],
    ['overridden by two things', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden', overridden_by: { subscription_id: 's', delivery_config_id: 'd' } }] }],
    ['unknown exclusion reason', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'too_big' }] }],
  ];
  for (const [name, doc] of bad) assert.equal(v(doc), false, `${name} is rejected`);
});

test('covered entries carry covered_from and the resolved offering', () => {
  const v = validate('/schemas/core/reporting-subscription-coverage.json');
  const covered = { media_buy_id: 'mb_1', covered_from: '2026-11-02T14:20:00Z', offering_id: 'daily', report_definition_id: 'def_v1' };
  assert.ok(v({ ...coverageBase, status: 'active', covered: [covered] }), JSON.stringify(v.errors));
  for (const key of ['covered_from', 'offering_id', 'report_definition_id', 'media_buy_id']) {
    const { [key]: _omit, ...missing } = covered;
    assert.equal(v({ ...coverageBase, status: 'active', covered: [missing] }), false, `${key} required`);
  }
  const regrant = { ...coverageBase, status: 'active', covered: [{ ...covered, covered_until: '2026-11-20T09:00:00Z' }, { ...covered, covered_from: '2026-11-25T00:00:00Z' }], gaps: [{ period: { start: '2026-11-20T09:00:00Z', end: '2026-11-25T00:00:00Z' }, reason: 'unauthorized' }] };
  assert.ok(v(regrant), JSON.stringify(v.errors));
});

test('get_reporting_status carries subscription_coverage in summary but not revision view', () => {
  const v = validate('/schemas/media-buy/get-reporting-status-response.json');
  const summary = {
    status: 'completed',
    view: 'summary',
    ledger_snapshot_id: 'snap_1',
    ledger_as_of: '2026-11-21T00:00:00Z',
    account_id: 'acc_1',
    scope: {
      period_start: '2026-11-01T00:00:00Z',
      period_end: '2026-11-21T00:00:00Z',
      scope_closed: true,
      all_accessible_media_buys: true,
      delivery_config_generations: [],
      feed_purposes: [],
      finality: [],
      ledger_retained_from: '2026-10-01T00:00:00Z',
      coverage_complete: true,
    },
    health: 'complete',
    coverage: {
      status: 'full',
      evaluated_at: '2026-11-21T00:00:00Z',
      media_buy_ids: [],
      fully_covered_media_buy_ids: [],
      partially_covered_media_buy_ids: [],
      unsupported_media_buy_ids: [],
      unknown_media_buy_ids: [],
      package_ids: [],
      covered_package_ids: [],
      unsupported_package_ids: [],
      unknown_package_ids: [],
      limitations: [],
    },
    data_through: null,
    obligation_counts: { total: 0, waiting: 0, healthy: 0, delayed: 0, action_required: 0, complete: 0 },
    issues: [],
    subscription_coverage: [{ ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden', overridden_by: { delivery_config_id: 'acct-analytics' } }] }],
  };
  assert.ok(v(summary), JSON.stringify(v.errors));
  const schema = read('media-buy/get-reporting-status-response.json');
  const revisionView = schema.oneOf[0].oneOf.find(s => s.title === 'Revision view');
  assert.ok(JSON.stringify(revisionView.not).includes('subscription_coverage'), 'revision view excludes subscription_coverage');
  assert.equal(schema['x-adcp-validation'].revoked_account_reads, undefined, 'no read carve-out for former principals');
  assert.match(schema['x-adcp-validation'].caller_isolation, /identical lookup_unavailable shape/);
  assert.match(schema['x-adcp-validation'].subscription_coverage, /start(ing)? at or after covered_from/);
});

function capabilities({ subscriptions = true, section = true, feature = true, tasks = ['sync_principal', 'sync_accounts'] } = {}) {
  const reportingDelivery = {
    supported: true,
    configuration_task: 'sync_accounts',
    status_task: 'get_reporting_status',
    offerings: [{
      offering_id: 'analytics-daily',
      feed_purpose: 'analytics',
      report_definition_id: 'def_v1',
      report_definition_uri: 'https://seller.example/reporting/def_v1.json',
      report_definition_sha256: 'a'.repeat(64),
      reporting_profile: {
        id: 'media_buy_delivery_v1',
        version: '1.0',
        schema_uri: 'https://seller.example/reporting/schema.json',
        schema_sha256: 'b'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        grain: 'media_buy-day',
        primary_keys: ['account_id', 'media_buy_id', 'period_start'],
      },
      schedule: { period_duration: 'P1D', alignment: 'account_timezone', delivery_sla: 'PT4H' },
      supported_finality: ['official'],
      reconciliation_mode: 'delivery_only',
    }],
    automated_recovery_window_seconds: 3600,
    status_retention_days: 30,
  };
  if (tasks) reportingDelivery.configuration_tasks = tasks;
  if (subscriptions) reportingDelivery.subscriptions = { supported: true, max_accounts: 500, backfill_on_regrant: false, dimensions: ['package', 'creative'] };
  const doc = {
    status: 'completed',
    adcp: {
      major_versions: [3],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
      principal: {
        supported: true,
        sync_task: 'sync_principal',
        read_task: 'get_principal',
        supported_sections: section ? ['declarations', 'reporting_subscriptions'] : ['declarations'],
        optimistic_concurrency: true,
      },
    },
    supported_protocols: ['media_buy'],
    media_buy: { reporting_delivery: reportingDelivery },
    experimental_features: ['protocol.principal', 'media_buy.reporting_delivery'],
  };
  if (feature) doc.experimental_features.push('media_buy.reporting_subscriptions');
  return doc;
}

test('advertising subscriptions requires the feature id, the section, and sync_principal in configuration_tasks', () => {
  const v = validate('/schemas/protocol/get-adcp-capabilities-response.json');
  assert.ok(v(capabilities()), JSON.stringify(v.errors));
  assert.ok(v(capabilities({ subscriptions: false, section: false, feature: false, tasks: null })), `pre-3.3 shape still validates: ${JSON.stringify(v.errors)}`);
  assert.ok(v(capabilities({ subscriptions: false, section: false, feature: false, tasks: ['sync_accounts'] })), JSON.stringify(v.errors));

  assert.equal(v(capabilities({ feature: false })), false, 'subscriptions without media_buy.reporting_subscriptions');
  assert.equal(v(capabilities({ section: false })), false, 'subscriptions without the sync_principal section');
  assert.equal(v(capabilities({ subscriptions: false })), false, 'section without the subscriptions block');
  assert.equal(v(capabilities({ tasks: null })), false, 'subscriptions without configuration_tasks');
  assert.equal(v(capabilities({ tasks: ['sync_accounts'] })), false, 'subscriptions without sync_principal listed');
  assert.equal(v(capabilities({ subscriptions: false, section: false, tasks: ['sync_principal', 'sync_accounts'] })), false, 'sync_principal listed without subscriptions');
  assert.equal(v(capabilities({ tasks: ['sync_principal'] })), false, 'sync_accounts stays listed during 3.x');
});

test('configuration_task stays the unchanged sync_accounts constant', () => {
  const caps = read('core/reporting-delivery-capabilities.json');
  assert.equal(caps.properties.configuration_task.const, 'sync_accounts');
  assert.match(caps.properties.configuration_task.description, /Deprecated/);
  assert.ok(caps.required.includes('configuration_task'));
  assert.deepEqual(caps.properties.configuration_tasks.items.enum, ['sync_principal', 'sync_accounts']);
  assert.equal(caps.properties.subscriptions['x-status'], 'experimental');
});

test('new schemas are registered in the index and the entity registry', () => {
  const index = JSON.stringify(read('index.json'));
  for (const id of [
    '/schemas/core/reporting-subscription.json',
    '/schemas/core/reporting-subscription-state.json',
    '/schemas/core/reporting-subscription-coverage.json',
    '/schemas/enums/reporting-dimension.json',
  ]) {
    assert.ok(index.includes(id), `${id} is in index.json`);
    assert.equal(read(id.replace('/schemas/', ''))['x-status'], 'experimental', id);
  }
  assert.ok(read('core/x-entity-types.json').enum.includes('reporting_subscription'));
});
