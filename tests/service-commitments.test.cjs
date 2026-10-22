const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'static/schemas/source');
const read = (name) => JSON.parse(fs.readFileSync(path.join(SOURCE, name), 'utf8'));
const cache = new Map();
async function compile(name) {
  if (!cache.has(name)) {
    const ajv = new Ajv({
      allErrors: true, strict: false, discriminator: true,
      loadSchema: async (uri) => {
        assert.ok(uri.startsWith('/schemas/'), `unexpected schema reference: ${uri}`);
        return read(uri.slice('/schemas/'.length));
      },
    });
    addFormats(ajv);
    cache.set(name, ajv.compileAsync(read(name)));
  }
  return cache.get(name);
}
function accepts(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}
function rejects(validate, value) {
  assert.equal(validate(value), false, `unexpectedly accepted ${JSON.stringify(value)}`);
}
const business = { clock: 'business', business_calendar_id: 'review_team_2027_q1', completion_max: 'P1D' };
const escalation = { response_max: 'PT15M', completion_max: 'PT2H' };
const policy = { co_branding: 'none', landing_page: 'any', templates_available: false, review_sla: business };
const report = {
  idempotency_key: 'critical-tracker-20270111-001',
  account: { account_id: 'account_123' }, media_buy_id: 'media_buy_789',
  severity: 'critical', category: 'tracking', description: 'An unapproved tracker is firing.',
};
const issue = {
  issue_id: 'issue_123', media_buy_id: 'media_buy_789',
  severity: 'critical', category: 'tracking', description: report.description,
  status: 'reported', revision: 1, received_at: '2027-01-11T20:00:00Z',
  sla: escalation, response_due_at: '2027-01-11T20:15:00Z', completion_due_at: '2027-01-11T22:00:00Z',
};
const calendar = {
  calendar_id: business.business_calendar_id, timezone: 'America/New_York',
  published_at: '2026-11-01T00:00:00Z', valid_from: '2027-01-01', valid_through: '2027-03-31',
  business_day_minutes: 540,
  working_periods: [{ days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '09:00', end_time: '18:00' }],
  non_working_dates: ['2027-01-01'],
};

test('legacy elapsed SLA windows retain their wire shape and default clock', async () => {
  const validate = await compile('core/sla-window.json');
  for (const value of [{}, escalation, { completion_max: 'PT24H' }, { clock: 'elapsed', completion_max: 'P1D' }, { response_max: 'PT4H', completion_max: 'PT2H' }]) accepts(validate, value);
  assert.equal(read('core/sla-window.json').properties.clock.default, 'elapsed');
  rejects(validate, { response_time_minutes: 15 });
  rejects(validate, { clock: 'business_days', completion_max: 'P1D' });
});

test('business SLAs require a calendar and calendar references require an explicit business clock', async () => {
  const validate = await compile('core/sla-window.json');
  accepts(validate, business);
  accepts(validate, { ...business, response_max: 'PT4H', completion_max: 'P1DT2H30M15S' });
  rejects(validate, { clock: 'business', completion_max: 'P1D' });
  rejects(validate, { ...business, business_calendar_id: '' });
  rejects(validate, { business_calendar_id: 'review_team_2027_q1', completion_max: 'P1D' });
  rejects(validate, { ...business, clock: 'elapsed' });
  for (const duration of ['P1M', 'P1Y', 'P1W', 'PT', 'P1DT', 'P', 'PT1.5H', 'P-1D']) {
    rejects(validate, { ...business, completion_max: duration });
  }
});

test('calendars carry an explicit working day, weekly schedule, coverage, and complete closures', async () => {
  const validate = await compile('core/business-calendar.json');
  accepts(validate, calendar);
  accepts(validate, { ...calendar, non_working_dates: [] });
  accepts(validate, { ...calendar, working_periods: [{ days: ['sunday'], start_time: '18:00', end_time: '24:00' }] });
  for (const field of Object.keys(calendar)) {
    const value = structuredClone(calendar);
    delete value[field];
    rejects(validate, value);
  }
  for (const value of [
    { timezone: 'inventory_local' }, { timezone: '' }, { business_day_minutes: 0 },
    { business_day_minutes: 1441 }, { working_periods: [] }, { non_working_dates: ['2027-02-30'] },
    { valid_through: 'next month' }, { non_working_dates: ['2027-01-01', '2027-01-01'] },
  ]) rejects(validate, { ...calendar, ...value });
  for (const value of [
    { days: [] }, { days: ['holiday'] }, { days: ['monday', 'monday'] },
    { start_time: '24:00' }, { start_time: '9:00' }, { end_time: '18:60' },
  ]) rejects(validate, { ...calendar, working_periods: [{ ...calendar.working_periods[0], ...value }] });
});

test('creative review requires a completion commitment and is available through both product profiles', async () => {
  const validatePolicy = await compile('core/creative-policy.json');
  accepts(validatePolicy, policy);
  accepts(validatePolicy, { ...policy, review_sla: { completion_max: 'PT4H' } });
  rejects(validatePolicy, { ...policy, review_sla: { response_max: 'PT5M' } });
  rejects(validatePolicy, { ...policy, review_sla: { clock: 'business', completion_max: 'P1D' } });
  const validateProduct = await compile('core/canonical-product.json');
  accepts(validateProduct, { product_id: 'streamhaus_display', name: 'Display', creative_policy: policy });
  const validateFields = await compile('media-buy/product-fields.json');
  accepts(validateFields, ['product_id', 'name', 'creative_policy', 'allowed_actions']);
  assert.equal(read('core/product.json').properties.creative_policy.$ref, '/schemas/core/creative-policy.json');
});

test('creative review is distinct from action ingestion and restricted to review-bearing actions', async () => {
  for (const name of ['core/product-allowed-action.json', 'core/canonical-product-action.json']) {
    const validate = await compile(name);
    accepts(validate, { action: 'replace_creative', modes: ['seller_managed'], sla: { completion_max: 'PT5M' }, review_sla: business });
    rejects(validate, { action: 'pause', modes: ['seller_managed'], review_sla: business });
  }
  for (const name of ['core/media-buy-available-action.json', 'core/canonical-media-buy-action.json']) {
    const validate = await compile(name);
    accepts(validate, { action: 'replace_creative', task: 'sync_creatives', mode: 'seller_managed', sla: { completion_max: 'PT5M' }, review_sla: business, applicable_package_ids: ['package_video'] });
    rejects(validate, { action: 'pause', task: 'control_media_buy', mode: 'self_serve', review_sla: business });
  }
});

test('escalation commitments require human response timing and prohibit business clocks', async () => {
  const validate = await compile('core/escalation-sla.json');
  accepts(validate, escalation);
  accepts(validate, { clock: 'elapsed', response_max: 'PT15M' });
  rejects(validate, {});
  rejects(validate, { completion_max: 'PT2H' });
  rejects(validate, { ...escalation, clock: 'business', business_calendar_id: calendar.calendar_id });
  for (const duration of ['P1Y', 'P1M', 'PT', 'P1DT']) rejects(validate, { response_max: duration });
});

test('report actions resolve through product and buy projections with elapsed critical commitments', async () => {
  for (const name of ['core/product-allowed-action.json', 'core/canonical-product-action.json']) {
    const validate = await compile(name);
    const value = { action: 'report_media_buy_issue', modes: ['seller_managed'], allowed_statuses: ['active', 'paused'], sla: escalation };
    accepts(validate, value);
    accepts(validate, { action: value.action, modes: value.modes });
    rejects(validate, { ...value, sla: business });
    rejects(validate, { ...value, modes: ['self_serve'] });
  }
  for (const name of ['core/media-buy-available-action.json', 'core/canonical-media-buy-action.json']) {
    const validate = await compile(name);
    const value = { action: 'report_media_buy_issue', task: 'report_media_buy_issue', mode: 'seller_managed', sla: escalation };
    accepts(validate, value);
    rejects(validate, { ...value, sla: business });
    rejects(validate, { ...value, task: 'control_media_buy' });
    rejects(validate, { ...value, mode: 'self_serve' });
  }
});

test('report requests require replay identity, authorized resource context, severity, category, and description', async () => {
  const validate = await compile('media-buy/report-media-buy-issue-request.json');
  accepts(validate, report);
  accepts(validate, { ...report, adcp_version: '3.3', context_id: 'compatibility-only', governance_context: 'signed-delegation' });
  rejects(validate, { ...report, adcp_version: '3.3.0' });
  accepts(validate, { ...report, severity: 'warning', package_id: 'package_video', creative_id: 'creative_123' });
  for (const field of ['idempotency_key', 'account', 'media_buy_id', 'severity', 'category', 'description']) {
    const value = structuredClone(report);
    delete value[field];
    rejects(validate, value);
  }
  for (const fields of [
    { severity: 'urgent' }, { category: 'billing_dispute' }, { description: '' },
    { description: 'x'.repeat(4001) }, { status: 'resolved' }, { acknowledged_at: issue.received_at },
    { idempotency_key: 'too-short' }, { package_id: '' },
  ]) rejects(validate, { ...report, ...fields });
});

test('negotiated escalation terms cannot introduce a business clock or self-serve acknowledgement', async () => {
  const validate = await compile('media-buy/change-term.json');
  const term = { term_id: 'critical_response', action: 'report_media_buy_issue', service_mode: 'seller_managed', processing_sla: escalation };
  accepts(validate, term);
  rejects(validate, { ...term, processing_sla: business });
  rejects(validate, { ...term, service_mode: 'self_serve' });
  accepts(validate, { term_id: 'review_change', action: 'replace_creative', service_mode: 'seller_managed', processing_sla: business });
});

test('negotiated creative terms bind independent ingestion and terminal review commitments', async () => {
  const validate = await compile('media-buy/change-term.json');
  const processing = { completion_max: 'PT5M' };
  const term = { term_id: 'creative_change', action: 'replace_creative', service_mode: 'seller_managed', processing_sla: processing, review_sla: business };
  accepts(validate, term);
  rejects(validate, { ...term, action: 'pause' });
  rejects(validate, { ...term, action: 'report_media_buy_issue', processing_sla: escalation });
  rejects(validate, { ...term, review_sla: { response_max: 'PT5M' } });
  const validateAction = await compile('core/canonical-media-buy-action.json');
  accepts(validateAction, { task: 'sync_creatives', action: term.action, mode: term.service_mode, change_term_id: term.term_id, sla: processing, review_sla: business });
});

test('polling a report requires account, media buy, and issue identities', async () => {
  const validate = await compile('media-buy/get-media-buy-issue-request.json');
  const value = { account: report.account, media_buy_id: issue.media_buy_id, issue_id: issue.issue_id };
  accepts(validate, value);
  for (const field of Object.keys(value)) {
    const missing = { ...value };
    delete missing[field];
    rejects(validate, missing);
  }
  rejects(validate, { ...value, issue_id: '' });
});

test('reported, acknowledged, and resolved issue snapshots enforce distinct lifecycle fields', async () => {
  const validate = await compile('core/media-buy-issue.json');
  accepts(validate, issue);
  const acknowledged = { ...issue, status: 'acknowledged', revision: 2, acknowledged_at: '2027-01-11T20:10:00Z' };
  accepts(validate, acknowledged);
  const resolved = { ...acknowledged, status: 'resolved', revision: 3, resolved_at: '2027-01-11T20:40:00Z', resolution: 'The unapproved tracker was disabled.' };
  accepts(validate, resolved);
  for (const value of [
    { ...issue, acknowledged_at: acknowledged.acknowledged_at },
    { ...issue, status: 'acknowledged' },
    { ...acknowledged, resolved_at: resolved.resolved_at },
    { ...acknowledged, resolution: resolved.resolution },
    { ...resolved, acknowledged_at: undefined },
    { ...resolved, resolved_at: undefined },
    { ...resolved, resolution: undefined },
    { ...issue, status: 'in_progress' }, { ...issue, revision: 0 },
  ]) rejects(validate, value);
});

test('deadline fields and critical-only SLA snapshots cannot be detached from their commitment', async () => {
  const validate = await compile('core/media-buy-issue.json');
  const noSla = { ...issue };
  delete noSla.sla;
  delete noSla.response_due_at;
  delete noSla.completion_due_at;
  accepts(validate, noSla);
  accepts(validate, { ...noSla, severity: 'warning' });
  rejects(validate, { ...issue, severity: 'warning' });
  rejects(validate, { ...noSla, response_due_at: issue.response_due_at });
  rejects(validate, { ...noSla, completion_due_at: issue.completion_due_at });
  rejects(validate, { ...issue, response_due_at: undefined });
  rejects(validate, { ...issue, completion_due_at: undefined });
  rejects(validate, { ...issue, sla: { response_max: 'PT15M' } });
  const responseOnly = { ...issue, sla: { response_max: 'PT15M' } };
  delete responseOnly.completion_due_at;
  accepts(validate, responseOnly);
});

test('report and polling responses separate stored snapshots from task errors', async () => {
  for (const name of ['report-media-buy-issue', 'get-media-buy-issue']) {
    const validate = await compile(`media-buy/${name}-response.json`);
    const outcome = name.startsWith('report') ? 'recorded' : 'found';
    accepts(validate, { outcome, issue });
    accepts(validate, { outcome: 'failed', errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'The referenced resource is unavailable.' }] });
    rejects(validate, {});
    rejects(validate, { outcome, issue, errors: [{ code: 'INVALID_REQUEST', message: 'Invalid' }] });
    rejects(validate, { outcome: 'failed', errors: [] });
    rejects(validate, { outcome, issue, acknowledged_at: '2027-01-11T20:10:00Z' });
    if (name.startsWith('report')) accepts(validate, { outcome, issue, replayed: true });
  }
});

test('capability declarations publish calendars without implying a product timing promise', async () => {
  const validate = await compile('protocol/get-adcp-capabilities-response.json');
  const value = { status: 'completed', adcp_version: '3.3', adcp: { major_versions: [3], supported_versions: ['3.3'], idempotency: { supported: true, replay_ttl_seconds: 86400 } }, supported_protocols: ['media_buy'], business_calendars: [calendar], media_buy: { issue_reporting: true } };
  accepts(validate, value);
  rejects(validate, { ...value, business_calendars: [] });
  rejects(validate, { ...value, business_calendars: [{ ...calendar, timezone: 'inventory_local' }] });
  rejects(validate, { ...value, media_buy: { issue_reporting: 'yes' } });
  rejects(validate, { ...value, adcp: { ...value.adcp, idempotency: { supported: false } } });
  rejects(validate, { ...value, adcp: { ...value.adcp, idempotency: { supported: true } } });
  accepts(validate, { ...value, media_buy: { issue_reporting: false }, adcp: { ...value.adcp, idempotency: { supported: false } } });
});

test('new tasks and identities are discoverable and correctly marked for the 3.3 build', () => {
  const registry = read('index.json');
  for (const name of ['report-media-buy-issue', 'get-media-buy-issue']) {
    const entry = registry.schemas['media-buy'].tasks[name];
    for (const kind of ['request', 'response']) {
      assert.equal(entry[kind].$ref, `/schemas/media-buy/${name}-${kind}.json`);
      assert.equal(read(`media-buy/${name}-${kind}.json`)['x-added-in'], '3.3.0');
    }
  }
  assert.equal(read('media-buy/report-media-buy-issue-request.json')['x-mutates-state'], true);
  for (const entity of ['business_calendar', 'media_buy_issue']) assert.ok(read('core/x-entity-types.json').enum.includes(entity));
});
