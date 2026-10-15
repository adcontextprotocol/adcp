const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_DIR = path.join(__dirname, '../static/schemas/source');
const readSchema = relativePath => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relativePath), 'utf8'));
const ajv = new Ajv({
  allErrors: true, strict: false, discriminator: true,
  loadSchema: async uri => readSchema(uri.replace('/schemas/', ''))
});
addFormats(ajv);
const validators = new Map();
function compile(relativePath) {
  if (!validators.has(relativePath)) {
    validators.set(relativePath, ajv.getSchema(`/schemas/${relativePath}`) || ajv.compileAsync(readSchema(relativePath)));
  }
  return validators.get(relativePath);
}

const impression = { event: 'impression', url: 'https://measurement.example/imp?mb=mb_a&cb={CACHEBUSTER}' };
const custom = { event: 'custom', custom_event_name: 'engagement_3s', url: 'https://measurement.example/engagement' };
const requestBase = { account: { account_id: 'acct_acme' }, idempotency_key: 'assignment-trackers-test-0001' };
const assignment = { creative_id: 'hero', package_id: 'pkg_display' };
const cases = [
  {
    schema: 'media-buy/create-media-buy-request.json', write: true,
    data: { ...requestBase, brand: { domain: 'acme.example' },
      start_time: '2026-11-01T00:00:00Z', end_time: '2026-11-30T23:59:59Z',
      packages: [{ product_id: 'display', pricing_option_id: 'cpm', budget: 1000,
        creative_assignments: [{ creative_id: 'hero' }] }] },
    row: data => data.packages[0].creative_assignments[0]
  },
  {
    schema: 'media-buy/update-media-buy-request.json', write: true,
    data: { ...requestBase, media_buy_id: 'mb_display',
      packages: [{ package_id: 'pkg_display', creative_assignments: [{ creative_id: 'hero' }] }] },
    row: data => data.packages[0].creative_assignments[0]
  },
  {
    schema: 'creative/sync-creatives-request.json', write: true,
    data: { ...requestBase, assignments: [{ ...assignment }] },
    row: data => data.assignments[0]
  },
  {
    schema: 'creative/sync-creatives-request.json', write: true,
    data: { ...requestBase, assignment_operations: [{ operation: 'assign', ...assignment }] },
    row: data => data.assignment_operations[0]
  },
  {
    schema: 'creative/list-creatives-response.json', write: false,
    data: { status: 'completed', query_summary: { total_matching: 1, returned: 1 }, pagination: { has_more: false },
      creatives: [{ creative_id: 'hero', name: 'Hero', format_kind: 'image', status: 'approved',
        created_date: '2026-10-15T12:00:00Z', updated_date: '2026-10-15T12:00:00Z',
        assignments: { assignment_count: 1, returned_assignment_count: 1, assignments_truncated: false,
          assigned_packages: [{ package_id: 'pkg_display', assigned_date: '2026-10-15T12:00:00Z' }] } }] },
    row: data => data.creatives[0].assignments.assigned_packages[0]
  },
  {
    schema: 'media-buy/get-media-buys-response.json', write: false,
    data: { status: 'completed', media_buys: [{ media_buy_id: 'mb_display', status: 'active', currency: 'USD',
      total_budget: 1000, confirmed_at: '2026-10-15T12:00:00Z', revision: 1,
      packages: [{ package_id: 'pkg_display', creative_approvals: [{ creative_id: 'hero', approval_status: 'approved' }] }] }] },
    row: data => data.media_buys[0].packages[0].creative_approvals[0]
  }
];

test('assignment trackers share pixel events and macro-bearing URLs, with strict custom-event names', async () => {
  const validate = await compile('core/assignment-tracker.json');
  for (const event of readSchema('enums/pixel-tracking-event.json').enum) {
    const tracker = { ...impression, event };
    if (event === 'custom') tracker.custom_event_name = 'engagement_3s';
    assert.equal(validate(tracker), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ ...impression, vendor_metadata: { campaign: 'spring' } }), true,
    JSON.stringify(validate.errors));
  for (const url of [
    'https://measurement.example/imp?cb=%%CACHEBUSTER%%',
    'https://measurement.example/imp?cb=[CACHEBUSTING]',
    'https://measurement.example/imp?cb=${CACHEBUSTER}'
  ]) {
    assert.equal(validate({ ...impression, url }), true, JSON.stringify(validate.errors));
  }
  for (const tracker of [
    { url: impression.url }, { event: 'impression' },
    { ...impression, event: 'invented_event' }, { ...impression, event: 'custom' },
    { ...custom, custom_event_name: '' }, { ...custom, custom_event_name: null },
    { ...custom, custom_event_name: 42 }, { ...impression, custom_event_name: 'engagement_3s' },
    ...[null, 42, {}, 'not a URL with spaces'].map(url => ({ ...impression, url })),
    { ...impression, method: 'js' }, { ...impression, asset_type: 'pixel_tracker' },
    { ...impression, macro_declarations: [] }
  ]) {
    assert.equal(validate(tracker), false, JSON.stringify(tracker));
  }
});

test('complete create, update, sync, list, and get messages validate optional assignment tracker lists', async () => {
  for (const { schema, data, row, write } of cases) {
    const validate = await compile(schema);
    assert.equal(validate(data), true, `${schema}: ${JSON.stringify(validate.errors)}`);
    for (const trackers of [[impression], [impression, custom], [impression, impression],
      [{ ...impression, vendor_metadata: { campaign: 'spring' } }], []]) {
      const message = structuredClone(data);
      row(message).trackers = trackers;
      assert.equal(validate(message), trackers.length > 0 || !write, `${schema}: ${JSON.stringify(validate.errors)}`);
    }
    for (const trackers of [null, {}, 'tracker', [null], [{ event: 'impression' }],
      [{ ...impression, url: 42 }], [{ ...custom, custom_event_name: '' }],
      [{ ...impression, event: 'custom' }], [{ ...impression, custom_event_name: 'extra' }]]) {
      const message = structuredClone(data);
      row(message).trackers = trackers;
      assert.equal(validate(message), false, `${schema}: ${JSON.stringify(trackers)}`);
    }
  }
});

test('sync supports multi-package assignment-only trafficking and atomic reset, limiting trackers to assign', async () => {
  const validate = await compile('creative/sync-creatives-request.json');
  assert.equal(validate({ ...requestBase, assignment_operations: [
    { operation: 'assign', ...assignment, trackers: [impression] },
    { operation: 'assign', ...assignment, package_id: 'pkg_other',
      trackers: [{ ...impression, url: 'https://measurement.example/imp?mb=mb_b&pkg=pkg_other' }] }
  ] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...requestBase, assignment_operations: [
    { operation: 'unassign', ...assignment },
    { operation: 'assign', ...assignment, weight: 50, landing_page_url: 'https://acme.example/offer' }
  ] }), true, JSON.stringify(validate.errors));
  for (const operation of ['unassign', 'replace']) {
    const op = { operation, ...assignment, trackers: [impression] };
    if (operation === 'replace') op.replaces_creative_id = 'old_hero';
    assert.equal(validate({ ...requestBase, assignment_operations: [op] }), false, operation);
  }
});

test('assignment tracker capability defaults off, requires a library, and is independent of landing-page support', async () => {
  const creative = readSchema('protocol/get-adcp-capabilities-response.json').properties.creative;
  assert.equal(creative.properties.supports_assignment_trackers.default, false);
  assert.equal(creative.properties.supports_assignment_trackers['x-added-in'], '3.3.0');
  const validate = await ajv.compileAsync(creative);
  for (const declaration of [{}, { supports_assignment_trackers: false },
    { supports_assignment_trackers: false, has_creative_library: false },
    { supports_assignment_trackers: true, has_creative_library: true, supports_assignment_landing_page: false },
    { supports_assignment_trackers: false, has_creative_library: true, supports_assignment_landing_page: true }]) {
    assert.equal(validate(declaration), true, JSON.stringify(validate.errors));
  }
  for (const declaration of [{ supports_assignment_trackers: true },
    { supports_assignment_trackers: true, has_creative_library: false },
    { supports_assignment_trackers: 'true', has_creative_library: true }]) {
    assert.equal(validate(declaration), false, JSON.stringify(declaration));
  }
});
