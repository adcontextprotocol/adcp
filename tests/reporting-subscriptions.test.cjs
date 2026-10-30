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
  const revoked = { account_id: 'acc_7', unauthorized_at: '2026-11-20T09:00:00Z', last_owed_period_end: '2026-11-20T05:00:00Z', withheld_period_count: 1, withheld_reporting_obligation_ids: ['obl_1'] };
  assert.ok(state({ ...current, accounts_unauthorized: [revoked] }), JSON.stringify(state.errors));
  const { withheld_period_count: _w, ...noCount } = revoked;
  assert.equal(state({ ...current, accounts_unauthorized: [noCount] }), false, 'withheld_period_count required');
  assert.equal(state({ ...current, accounts_unauthorized: [{ ...revoked, covered: [] }] }), false, 'no current account data');
  const caps = read('core/reporting-delivery-capabilities.json').properties.subscriptions.properties.backfill_on_regrant.description;
  assert.match(caps, /no gap is recorded/);
  assert.ok(state({ ...current, prior_versions: [{ subscription_version: 1, accepted_at: '2026-10-01T00:00:00Z', superseded_at: '2026-11-01T00:00:00Z' }] }), JSON.stringify(state.errors));
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
  assert.match(description, /precedence over every reporting subscription of the same caller/);
  const precedence = read('core/reporting-subscription.json')['x-adcp-validation'].precedence;
  assert.match(precedence, /the caller's own active sync_accounts reporting_delivery_configs entry/);
  assert.match(precedence, /Another principal's configurations and subscriptions never affect this one, and overridden_by never names them/);
});

const coverageBase = { subscription_id: 'analytics-daily', subscription_version: 1, excluded: [] };
const from = '2026-11-03T05:00:00Z';

test('coverage readback lists exceptions only, each with its interval', () => {
  const schema = read('core/reporting-subscription-coverage.json');
  for (const gone of ['covered', 'covered_from', 'covered_until', 'unauthorized_at', 'withheld_unauthorized']) {
    assert.equal(schema.properties[gone], undefined, `no positive ${gone} listing`);
  }
  assert.match(schema.description, /The seller reports only exceptions/);
  const v = validate('/schemas/core/reporting-subscription-coverage.json');
  const review = { waiting_on: 'seller', kind: 'review', message: 'Capacity review.' };
  const ok = [
    { ...coverageBase, status: 'active' },
    { ...coverageBase, status: 'active', excluded: [{ media_buy_id: 'mb_1', reason: 'offering_unsupported', from }, { reason: 'capacity', from, until: '2026-11-10T05:00:00Z' }] },
    { ...coverageBase, status: 'excluded', excluded: [{ reason: 'capacity', from }] },
    { ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden', from, overridden_by: { delivery_config_id: 'acct-analytics' } }] },
    { ...coverageBase, status: 'action_required', pending_action: review, excluded: [{ reason: 'action_required', from }] },
    { ...coverageBase, status: 'active', gaps: [{ from: '2026-11-20T05:00:00Z', until: '2026-11-25T05:00:00Z', reason: 'unauthorized' }] },
  ];
  for (const doc of ok) assert.ok(v(doc), `${doc.status}: ${JSON.stringify(v.errors)}`);

  const bad = [
    ['a positive covered listing', { ...coverageBase, status: 'active', covered: [] }],
    ['unauthorized is not an account status here', { ...coverageBase, status: 'unauthorized' }],
    ['an exception without from', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'capacity' }] }],
    ['a gap without until', { ...coverageBase, status: 'active', gaps: [{ from, reason: 'unauthorized' }] }],
    ['action_required without pending_action', { ...coverageBase, status: 'action_required', excluded: [{ reason: 'action_required', from }] }],
    ['action_required without an open account-level entry', { ...coverageBase, status: 'action_required', pending_action: review }],
    ['pending_action on an active account', { ...coverageBase, status: 'active', pending_action: review }],
    ['active with an open account-level exclusion', { ...coverageBase, status: 'active', excluded: [{ reason: 'capacity', from }] }],
    ['excluded with only an ended account-level entry', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'capacity', from, until: '2026-11-10T05:00:00Z' }] }],
    ['excluded with only a buy-level entry', { ...coverageBase, status: 'excluded', excluded: [{ media_buy_id: 'mb_1', reason: 'capacity', from }] }],
    ['overridden without the overriding id', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden', from }] }],
    ['overridden_by on another reason', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'capacity', from, overridden_by: { subscription_id: 's' } }] }],
    ['overridden by two things', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden', from, overridden_by: { subscription_id: 's', delivery_config_id: 'd' } }] }],
    ['unauthorized is not an exclusion reason', { ...coverageBase, status: 'excluded', excluded: [{ reason: 'unauthorized', from }] }],
    ['action_required on one buy', { ...coverageBase, status: 'active', excluded: [{ media_buy_id: 'mb_1', reason: 'action_required', from }] }],
  ];
  for (const [name, doc] of bad) assert.equal(v(doc), false, `${name} is rejected`);
});

// Reference computation of the documented rule for a daily schedule at a fixed offset.
// Owed periods start on or after the first boundary at or after max(accepted_at, authorized_at),
// end after confirmed_at (the period in which the buy is confirmed is owed in full), and overlap
// the flight [start_time, stop) (an empty flight overlaps nothing),
// stop = min(end_time, canceled_at, completed_at). Flight values are those in force at each
// period's scope_resolved_at (here: period end), given as a history of { asOf, ...flight }.
// Exceptions remove periods whose start is in [from, until). Never clipped.
const DAY = 86_400_000;
function expectedPeriods({ acceptedAt, confirmedAt, authorizedAt, startTime, endTime, canceledAt, completedAt, history, offsetHours, exceptions = [] }) {
  const origin = -offsetHours * 3_600_000; // local midnight expressed in UTC ms
  const t = v => (v ? Date.parse(v) : -Infinity);
  const later = Math.max(t(acceptedAt), t(authorizedAt));
  const confirmed = t(confirmedAt);
  const flightAt = when => {
    const base = { startTime, endTime, canceledAt, completedAt };
    for (const h of history || []) if (Date.parse(h.asOf) <= when) Object.assign(base, h);
    return base;
  };
  const out = [];
  const horizon = Date.parse('2027-01-01T00:00:00Z');
  for (let start = origin + Math.ceil((later - origin) / DAY) * DAY; start < horizon; start += DAY) {
    const f = flightAt(start + DAY); // scope_resolved_at at period end
    const stop = Math.min(...[f.endTime, f.canceledAt, f.completedAt].filter(Boolean).map(Date.parse));
    const flightStart = Date.parse(f.startTime);
    if (start + DAY > confirmed && flightStart < stop && start < stop && start + DAY > flightStart) out.push(start);
  }
  return out
    .filter(p => !exceptions.some(e => p >= Date.parse(e.from) && (!e.until || p < Date.parse(e.until))))
    .map(p => new Date(p).toISOString());
}

test('the buyer computes the first owed period from accepted_at, authorized_at, confirmed_at, and the flight', () => {
  const rule = read('core/reporting-subscription.json')['x-adcp-validation'].coverage;
  assert.match(rule, /later of this version's accepted_at and the account's authorization\.authorized_at, that end after the buy's confirmed_at/);
  assert.match(rule, /The period in which the buy is confirmed is owed in full/);
  assert.match(rule, /overlap the buy's flight from start_time/);
  assert.match(rule, /each removing periods; none adds one/);
  assert.match(rule, /lists get_reporting_status in allowed_tasks/);
  assert.match(rule, /the caller can see through get_media_buys/);
  assert.match(read('core/reporting-subscription-state.json').properties.accepted_at.description, /account's authorized_at/);
  const authorizedAt = read('core/account-authorization.json').properties.authorized_at;
  assert.equal(authorizedAt['x-added-in'], '3.3.0');
  assert.match(authorizedAt.description, /MUST populate it/);

  // Account in UTC-5: local midnight is 05:00Z. Buy confirmed mid-day after the subscription was accepted.
  const base = { acceptedAt: '2026-11-01T12:00:00Z', confirmedAt: '2026-11-02T14:20:00Z', startTime: '2026-11-02T14:20:00Z', endTime: '2026-11-06T05:00:00Z', offsetHours: -5 };
  const owed = expectedPeriods(base);
  assert.deepEqual(owed, ['2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z', '2026-11-04T05:00:00.000Z', '2026-11-05T05:00:00.000Z'], 'the period in which the buy is confirmed is owed in full');
  assert.equal(expectedPeriods({ ...base, acceptedAt: '2026-11-04T01:00:00Z' })[0], '2026-11-04T05:00:00.000Z', 'a later acceptance moves the start');
  assert.equal(expectedPeriods({ ...base, authorizedAt: '2026-11-04T07:00:00Z' })[0], '2026-11-05T05:00:00.000Z', 'a later grant moves the start');
  assert.equal(expectedPeriods({ ...base, confirmedAt: '2026-11-03T05:00:00Z', startTime: '2026-11-03T05:00:00Z' })[0], '2026-11-03T05:00:00.000Z', 'a confirmation on a boundary owes from that boundary');
  assert.deepEqual(expectedPeriods({ ...base, canceledAt: '2026-11-02T10:00:00Z', startTime: '2026-11-02T14:20:00Z' }), [], 'a buy canceled before its flight starts owes nothing');

  // Flight: confirmed Nov 1, starts Dec 1: nothing before Dec 1.
  const future = expectedPeriods({ acceptedAt: '2026-10-01T00:00:00Z', confirmedAt: '2026-11-01T10:00:00Z', startTime: '2026-12-01T05:00:00Z', endTime: '2026-12-03T05:00:00Z', offsetHours: -5 });
  assert.deepEqual(future, ['2026-12-01T05:00:00.000Z', '2026-12-02T05:00:00.000Z'], 'periods must overlap the flight');

  // Exceptions only subtract, by period start in [from, until).
  const minus = expectedPeriods({ ...base, exceptions: [{ from: '2026-11-04T05:00:00Z', until: '2026-11-05T05:00:00Z' }] });
  assert.deepEqual(minus, ['2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z', '2026-11-05T05:00:00.000Z']);
  assert.ok(minus.every(p => owed.includes(p)), 'no exception adds a period');
  assert.match(read('core/reporting-subscription-coverage.json').description, /removes the periods whose start falls in the half-open interval \[from, until\)/);
});

test('a buy stops being owed at the earliest of end_time, canceled_at, and completed_at, as resolved per period', () => {
  const rule = read('core/reporting-subscription.json')['x-adcp-validation'].coverage;
  assert.match(rule, /the earliest of end_time, cancellation\.canceled_at, and completed_at/);
  assert.match(rule, /evaluated at each period's scope_resolved_at/);
  assert.match(rule, /an elapsed period never becomes owed retroactively/);
  assert.match(rule, /so is the period containing the stop time/);
  assert.match(rule, /overlaps no period and owes nothing/);
  for (const [file, keys] of [['core/media-buy.json', ['properties', 'completed_at']], ['media-buy/get-media-buys-response.json', ['properties', 'media_buys', 'items', 'properties', 'completed_at']]]) {
    const field = keys.reduce((o, k) => o[k], read(file));
    assert.equal(field['x-added-in'], '3.3.0', file);
    assert.match(field.description, /MUST populate it for completed buys/, file);
  }
  assert.ok(!read('core/media-buy.json').required.includes('completed_at'), 'completed_at stays optional');

  const base = { acceptedAt: '2026-11-01T00:00:00Z', confirmedAt: '2026-11-02T14:20:00Z', startTime: '2026-11-02T14:20:00Z', endTime: '2026-11-06T05:00:00Z', offsetHours: -5 };
  const days = n => Array.from({ length: n }, (_, i) => new Date(Date.parse('2026-11-02T05:00:00Z') + i * DAY).toISOString());
  assert.deepEqual(expectedPeriods(base), days(4));
  assert.deepEqual(expectedPeriods({ ...base, canceledAt: '2026-11-04T18:00:00Z' }), days(3), 'canceled mid-period: that period owed in full, the next not');
  assert.deepEqual(expectedPeriods({ ...base, endTime: '2026-11-09T05:00:00Z' }), days(7), 'an end_time extension adds periods');
  assert.deepEqual(expectedPeriods({ ...base, completedAt: '2026-11-04T05:00:00Z' }), days(2), 'completion before end_time stops at completed_at');
  assert.deepEqual(expectedPeriods({ ...base, endTime: '2026-11-04T09:00:00Z' }), days(3), 'a mid-period end_time owes the period containing it');

  // Canceled Nov 4 18:00, then reinstated and extended on Nov 8: Nov 5-7 elapsed and stay unowed.
  const reinstated = expectedPeriods({
    ...base,
    history: [
      { asOf: '2026-11-04T18:00:00Z', canceledAt: '2026-11-04T18:00:00Z' },
      { asOf: '2026-11-08T12:00:00Z', canceledAt: undefined, endTime: '2026-11-10T05:00:00Z' },
    ],
  });
  assert.deepEqual(reinstated, ['2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z', '2026-11-04T05:00:00.000Z', '2026-11-08T05:00:00.000Z', '2026-11-09T05:00:00.000Z'], 'reinstating never makes elapsed periods owed');
});

// Reference resolver for the documented match modes.
function resolve(offerings, { dimensions, match }) {
  const mode = match || (dimensions ? 'exact' : 'finest');
  const want = dimensions || [];
  const superset = offerings.filter(o => want.every(d => o.dimensions.includes(d)));
  if (mode === 'exact') return superset.filter(o => o.dimensions.length + (o.unmapped || 0) === want.length).map(o => o.offering_id).sort().slice(0, 1);
  if (mode === 'all') return superset.map(o => o.offering_id);
  const max = Math.max(...superset.map(o => o.dimensions.length));
  return superset.filter(o => o.dimensions.length === max).map(o => o.offering_id).sort().slice(0, 1);
}

test('match exact is the default with dimensions and resolves only an equal breakdown', () => {
  const match = read('core/reporting-subscription.json').properties.selector.properties.match;
  assert.deepEqual(match.enum, ['exact', 'finest', 'all']);
  assert.equal(match.default, undefined, 'the default depends on dimensions, so it is described, not declared');
  assert.match(match.description, /Defaults to exact when dimensions is present and finest when it is absent/);
  assert.match(match.description, /Billing subscriptions SHOULD use exact/);

  const offerings = [
    { offering_id: 'pkg', dimensions: ['package'] },
    { offering_id: 'pkg_creative', dimensions: ['package', 'creative'] },
    { offering_id: 'pkg_country', dimensions: ['package', 'country'] },
  ];
  assert.deepEqual(resolve(offerings, { dimensions: ['package'] }), ['pkg'], 'default exact picks package only');
  assert.deepEqual(resolve(offerings, { dimensions: ['package'], match: 'finest' }), ['pkg_country'], 'finest: most dimensions, lowest offering_id');
  assert.deepEqual(resolve(offerings, { dimensions: ['package'], match: 'all' }), ['pkg', 'pkg_creative', 'pkg_country']);
  assert.deepEqual(resolve(offerings, { dimensions: ['creative'] }), [], 'exact with no equal offering resolves nothing: offering_unsupported');
  assert.deepEqual(resolve(offerings, {}), ['pkg_country'], 'no dimensions defaults to finest');
  assert.deepEqual(resolve([{ offering_id: 'pkg_device', dimensions: ['package'], unmapped: 1 }], { dimensions: ['package'] }), [], 'package by device does not equal package under exact');
  assert.deepEqual(resolve([{ offering_id: 'b', dimensions: ['package'] }, { offering_id: 'a', dimensions: ['package'] }], { dimensions: ['package'] }), ['a'], 'exact ties go to the lowest offering_id');
  assert.match(match.description, /native dimensions that do not map to the vocabulary count as distinct/);

  const v = validate('/schemas/core/reporting-subscription.json');
  assert.ok(v({ ...allAccounts, selector: { ...allAccounts.selector, match: 'exact' } }), JSON.stringify(v.errors));
});

test('replace_account_configs ends only the caller\'s own configs, where the subscription resolves, once per version', () => {
  const schema = read('core/reporting-subscription.json');
  const field = schema.properties.replace_account_configs;
  assert.equal(field.type, 'boolean');
  assert.match(field.description, /caller's own active sync_accounts reporting_delivery_configs/);
  assert.match(field.description, /where this subscription resolves an offering/);
  assert.match(field.description, /Applied once per subscription_version, or when the flag changes to true/);
  assert.match(field.description, /Never affects another principal's configurations or accounts this subscription excludes/);
  assert.match(schema['x-adcp-validation'].replace_account_configs, /the configuration outgoing, the subscription incoming/);
  const cutover = schema['x-adcp-validation'].cutover;
  assert.match(cutover, /the outgoing schedule owes its periods that start before T, in full/);
  assert.match(cutover, /the incoming schedule owes its periods that start at or after E/);
  assert.match(cutover, /Nothing is owed twice/);
  assert.match(cutover, /owed under neither/);
  assert.match(schema.properties.replace_account_configs.description, /never advances an account's revision/);
  assert.match(schema.properties.destination.properties.path_template.description, /percent-encodes/);
  const v = validate('/schemas/core/reporting-subscription.json');
  assert.ok(v({ ...allAccounts, replace_account_configs: true }), JSON.stringify(v.errors));
  assert.match(read('core/reporting-delivery-capabilities.json').properties.configuration_task.description, /pinned below 3\.3/);
});

test('scope versions, operator filter, alignment, and path safety', () => {
  const schema = read('core/reporting-subscription.json');
  assert.match(schema.properties.subscription_version.description, /scope, exclude_account_ids, or operator_domains change/);
  const v = validate('/schemas/core/reporting-subscription.json');
  assert.ok(v({ ...allAccounts, operator_domains: ['pinnacle-media.example'] }), JSON.stringify(v.errors));
  assert.equal(v({ ...allAccounts, operator_domains: ['Not A Domain'] }), false, 'operator domains are lowercase domains');
  assert.ok(v({ ...allAccounts, selector: { ...allAccounts.selector, alignment: 'account_timezone' } }), JSON.stringify(v.errors));
  assert.equal(v({ ...allAccounts, selector: { ...allAccounts.selector, alignment: 'local' } }), false, 'closed alignment values');
  for (const id of ['.', '..']) assert.equal(v({ ...allAccounts, subscription_id: id }), false, `subscription_id ${id}`);
  assert.ok(v({ ...allAccounts, subscription_id: 'a.b' }), 'dots inside an id are fine');
  for (const path of ['{account_id}/./x', '{account_id}/../x', './{account_id}', '{account_id}/.', '{account_id}/..']) {
    assert.equal(v({ ...allAccounts, destination: { destination_id: 'x', path_template: path } }), false, path);
  }
  assert.ok(v({ ...allAccounts, destination: { destination_id: 'x', path_template: 'a.b/{account_id}/v1.2' } }), 'dots inside segments are fine');
  assert.match(schema['x-adcp-validation'].destination, /more than one active subscription of the caller shares a destination/);
  assert.doesNotMatch(schema.properties.selector.properties.period_timezone.description, /account's timezone/);
});

test('coverage readback: per-package exceptions, timezone cutovers, discoverable exceptions', () => {
  const v = validate('/schemas/core/reporting-subscription-coverage.json');
  const base = { subscription_id: 's', subscription_version: 1, status: 'active' };
  assert.ok(v({ ...base, excluded: [{ media_buy_id: 'mb_1', reason: 'offering_unsupported', from: '2026-11-03T05:00:00Z', package_ids: ['pkg_dooh'] }] }), JSON.stringify(v.errors));
  assert.equal(v({ ...base, excluded: [{ media_buy_id: 'mb_1', reason: 'capacity', from: '2026-11-03T05:00:00Z', package_ids: ['pkg_dooh'] }] }), false, 'package_ids only with offering_unsupported');
  assert.equal(v({ ...base, status: 'excluded', excluded: [{ reason: 'offering_unsupported', from: '2026-11-03T05:00:00Z', package_ids: ['pkg_dooh'] }] }), false, 'package_ids need a media_buy_id');
  assert.ok(v({ ...base, excluded: [], timezone_cutovers: [{ effective_at: '2026-11-10T05:00:00Z', timezone: 'America/Los_Angeles' }] }), JSON.stringify(v.errors));
  const review = { waiting_on: 'seller', kind: 'review', message: 'x' };
  assert.equal(v({ ...base, status: 'excluded', excluded: [{ reason: 'capacity', from: '2026-11-03T05:00:00Z' }, { reason: 'action_required', from: '2026-11-03T05:00:00Z' }] }), false, 'excluded with an open action_required entry');
  assert.ok(v({ ...base, status: 'action_required', pending_action: review, excluded: [{ reason: 'capacity', from: '2026-11-03T05:00:00Z' }, { reason: 'action_required', from: '2026-11-03T05:00:00Z' }] }), JSON.stringify(v.errors));

  const state = validate('/schemas/core/reporting-subscription-state.json');
  const current = { subscription_id: 'analytics-daily', subscription_version: 2, state: 'active', accepted_at: '2026-11-01T00:00:00Z', configuration: allAccounts };
  assert.ok(state({ ...current, accounts_with_exceptions: [{ account_id: 'acc_1', reasons: ['capacity', 'offering_unsupported'] }] }), JSON.stringify(state.errors));
  assert.equal(state({ ...current, accounts_with_exceptions: [{ account_id: 'acc_1', reasons: [] }] }), false, 'reasons required');
  const prior = Array.from({ length: 40 }, (_, i) => ({ subscription_version: i + 1, accepted_at: '2026-10-01T00:00:00Z', superseded_at: '2026-10-02T00:00:00Z' }));
  assert.ok(state({ ...current, prior_versions: prior }), 'prior_versions is not capped at 16');
  assert.match(read('core/reporting-subscription-state.json').properties.accounts_unauthorized.description, /fresh coverage start from authorized_at with no gap claimed/);
});

test('obligation offering_id is authoritative for timing', () => {
  assert.match(read('core/reporting-obligation.json').properties.offering_id.description, /Authoritative for this obligation's timing/);
});

test('principal.changed announces reporting subscription changes', () => {
  const webhook = read('core/principal-changed-webhook.json');
  assert.ok(webhook.properties.reason.enum.includes('reporting_subscription_changed'));
  assert.match(read('core/reporting-subscription-state.json').properties.accounts_unauthorized.description, /reporting_subscription_changed/);
  const hook = validate('/schemas/core/principal-changed-webhook.json');
  const doc = { ...webhook.examples[0].data, reason: 'reporting_subscription_changed' };
  delete doc.destination_id;
  assert.ok(hook(doc), JSON.stringify(hook.errors));
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
    subscription_coverage: [{ ...coverageBase, status: 'excluded', excluded: [{ reason: 'overridden', from, overridden_by: { delivery_config_id: 'acct-analytics' } }] }],
  };
  assert.ok(v(summary), JSON.stringify(v.errors));
  const schema = read('media-buy/get-reporting-status-response.json');
  const revisionView = schema.oneOf[0].oneOf.find(s => s.title === 'Revision view');
  assert.ok(JSON.stringify(revisionView.not).includes('subscription_coverage'), 'revision view excludes subscription_coverage');
  assert.equal(schema['x-adcp-validation'].revoked_account_reads, undefined, 'no read carve-out for former principals');
  assert.match(schema['x-adcp-validation'].caller_isolation, /identical lookup_unavailable shape/);
  assert.match(schema['x-adcp-validation'].subscription_coverage, /exceptions never add periods/);
  assert.equal(read('core/reporting-obligation.json').properties.offering_id['x-added-in'], '3.3.0');
});

function capabilities({ subscriptions = true, section = true, feature = true, tasks = ['sync_principal', 'sync_accounts'], legacyTask } = {}) {
  const reportingDelivery = {
    supported: true,
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
  const withLegacy = legacyTask === undefined ? !tasks || tasks.includes('sync_accounts') : legacyTask;
  if (withLegacy) reportingDelivery.configuration_task = 'sync_accounts';
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
  assert.ok(v(capabilities({ tasks: ['sync_principal'] })), `a seller may list sync_principal alone: ${JSON.stringify(v.errors)}`);
  assert.equal(v(capabilities({ tasks: ['sync_principal'], legacyTask: true })), false, 'configuration_task without sync_accounts in configuration_tasks');
  assert.equal(v(capabilities({ tasks: ['sync_principal', 'sync_accounts'], legacyTask: false })), false, 'sync_accounts listed without configuration_task');
  assert.equal(v(capabilities({ subscriptions: false, section: false, feature: false, tasks: null, legacyTask: false })), false, 'pre-3.3 shape still needs configuration_task');
});

test('configuration_task stays the unchanged sync_accounts constant', () => {
  const caps = read('core/reporting-delivery-capabilities.json');
  assert.equal(caps.properties.configuration_task.const, 'sync_accounts');
  assert.match(caps.properties.configuration_task.description, /Deprecated/);
  assert.equal(caps.required.includes('configuration_task'), false, 'relaxed: present iff sync_accounts is served');
  assert.match(caps.properties.configuration_task.description, /MUST serve sync_accounts registration to them/);
  assert.match(read('core/account.json').properties.revision.description, /do not increment it/);
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

// Reference cutover between two daily schedules at fixed offsets.
function cutover(T, outOffsetH, inOffsetH, days = 3) {
  const t = Date.parse(T);
  const oOrigin = -outOffsetH * 3_600_000;
  const iOrigin = -inOffsetH * 3_600_000;
  const lastOutStart = oOrigin + Math.floor((t - 1 - oOrigin) / DAY) * DAY; // last outgoing start before T
  const E = lastOutStart + DAY;
  const firstIn = iOrigin + Math.ceil((E - iOrigin) / DAY) * DAY; // first incoming start at or after E
  return { E: new Date(E).toISOString(), firstIn: new Date(firstIn).toISOString(), uncovered: firstIn - E, incoming: Array.from({ length: days }, (_, k) => firstIn + k * DAY) };
}

test('cutovers never double count and leave at most a sub-period stretch when boundaries differ', () => {
  const sameTz = cutover('2026-11-10T12:00:00Z', -5, -5);
  assert.equal(sameTz.E, '2026-11-11T05:00:00.000Z');
  assert.equal(sameTz.uncovered, 0, 'shared boundaries: no stretch');
  const moved = cutover('2026-11-10T12:00:00Z', -5, -8);
  assert.equal(moved.E, '2026-11-11T05:00:00.000Z', 'old schedule keeps its last started period in full');
  assert.equal(moved.firstIn, '2026-11-11T08:00:00.000Z', 'new schedule starts at its first boundary at or after E');
  assert.ok(moved.uncovered > 0 && moved.uncovered < DAY, 'the unowed stretch is shorter than one incoming period');
  assert.ok(moved.incoming.every(start => start >= Date.parse(moved.E)), 'no incoming period overlaps the last outgoing one');
  const onBoundary = cutover('2026-11-10T05:00:00Z', -5, -5);
  assert.equal(onBoundary.E, '2026-11-10T05:00:00.000Z', 'T on an outgoing boundary is E');
});

test('readback exception reasons stay in sync with the coverage enum', () => {
  const state = read('core/reporting-subscription-state.json').properties.accounts_with_exceptions.items.properties.reasons.items.enum;
  const coverage = read('core/reporting-subscription-coverage.json').definitions.ReportingSubscriptionExclusionReason.enum;
  assert.deepEqual(state, coverage);
});

test('offerings publish mapped dimensions so a buyer resolves match from the wire', () => {
  const offering = read('core/reporting-delivery-offering.json');
  assert.equal(offering.properties.standard_dimensions.items.$ref, '/schemas/enums/reporting-dimension.json');
  assert.match(offering.properties.standard_dimensions.description, /MUST include it on every offering/);
  assert.match(offering.properties.unmapped_dimensions.description, /count as distinct under match exact/);
  const subscription = read('core/reporting-subscription.json');
  assert.match(subscription['x-adcp-validation'].selection, /publishes the result on the offering as standard_dimensions/);
  assert.match(subscription.properties.selector.properties.match.description, /With match exact and no dimensions, every candidate qualifies and the lowest offering_id wins/);
  assert.match(subscription.properties.selector.properties.period_timezone.description, /utc offering matches only when this is a UTC alias/);
});

test('cutovers, authorization chains, reactivation, and period arithmetic are pinned', () => {
  const v = read('core/reporting-subscription.json')['x-adcp-validation'];
  assert.match(v.cutover, /E is computed per incoming offering/);
  assert.match(v.coverage, /scope_resolved_at is the period end/);
  assert.match(v.coverage, /re-grant before unauthorized_at plus status_retention_days continues the earlier grant/);
  assert.match(v.coverage, /Reactivating an inactive subscription is a fresh start/);
  assert.match(read('core/account-authorization.json').properties.authorized_at.description, /continues the chain and leaves authorized_at unchanged/);
  assert.match(read('core/reporting-schedule.json')['x-adcp-validation'].period_generation, /Hours, minutes, and seconds are exact elapsed time/);
  assert.match(read('core/reporting-schedule.json')['x-adcp-validation'].period_generation, /zero length and is never owed/);
});

test('readback lists inactive intervals; coverage entries can be per offering', () => {
  const vState = validate('/schemas/core/reporting-subscription-state.json');
  const state = read('core/reporting-subscription-state.json');
  assert.ok(state.properties.inactive_intervals, 'inactive_intervals readback');
  assert.deepEqual(state.properties.inactive_intervals.items.required, ['deactivated_at']);
  const coverage = read('core/reporting-subscription-coverage.json');
  assert.ok(coverage.properties.gaps.items.properties.offering_id);
  assert.ok(coverage.properties.timezone_cutovers.items.properties.offering_id);
  assert.match(coverage.properties.timezone_cutovers.items.properties.previous_timezone.description, /Sellers MUST include it/);
  assert.ok(vState, 'state schema compiles');
});

test('prior_versions carry the configuration each version had', () => {
  const item = read('core/reporting-subscription-state.json').properties.prior_versions.items;
  assert.equal(item.properties.configuration.$ref, '/schemas/core/reporting-subscription.json');
  assert.match(item.properties.configuration.description, /Sellers MUST include it/);
});

test('sub-daily local periods restart at each local midnight, not at 1970 offsets', () => {
  const rule = read('core/reporting-schedule.json')['x-adcp-validation'].period_generation;
  assert.match(rule, /MUST divide 24 hours/);
  assert.match(rule, /counted afresh each local day/);
  assert.match(rule, /a 23-hour DST day has 23 hourly periods and a 25-hour day 25/);
});

test('exceptions can be per offering when boundaries differ', () => {
  const excluded = read('core/reporting-subscription-coverage.json').properties.excluded;
  assert.ok(excluded.items.properties.offering_id, 'excluded[].offering_id');
  assert.match(excluded.description, /one entry per offering_id/);
});
