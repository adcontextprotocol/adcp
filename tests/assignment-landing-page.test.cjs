const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_DIR = path.join(__dirname, '../static/schemas/source');

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relativePath), 'utf8'));
}

async function compile(schema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async uri => readSchema(uri.replace('/schemas/', ''))
  });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const syncSchema = readSchema('creative/sync-creatives-request.json');
const assignSchema = syncSchema.properties.assignment_operations.items.oneOf
  .find(variant => variant.properties.operation.const === 'assign');
const listAssignment = readSchema('creative/list-creatives-response.json')
  .properties.creatives.items.properties.assignments.properties.assigned_packages.items;
const buyAssignment = readSchema('media-buy/get-media-buys-response.json')
  .properties.media_buys.items.properties.packages.items.properties.creative_approvals.items;
const urls = [
  'https://example.com/offer',
  'https://example.com/offer?item={PRODUCT_ID}',
  'https://example.com/offer?cb=%%CACHEBUSTER%%',
  'https://example.com/offer?cb=[CACHEBUSTING]'
];
const invalidUrls = [null, 42, {}, 'not a URL with spaces'];
const requestBase = {
  account: { account_id: 'acct_acme' },
  idempotency_key: 'assignment-landing-page-0001'
};

test('package create, update, and read assignments accept optional macro-bearing landing pages', async () => {
  for (const relativePath of ['media-buy/package-request.json', 'media-buy/package-update.json', 'core/package.json']) {
    const assignment = readSchema(relativePath).properties.creative_assignments.items;
    assert.equal(assignment.$ref, '/schemas/core/creative-assignment.json');
    const validate = await compile(assignment);
    assert.equal(validate({ creative_id: 'hero' }), true, JSON.stringify(validate.errors));
    for (const landing_page_url of urls) {
      assert.equal(validate({ creative_id: 'hero', landing_page_url }), true, JSON.stringify(validate.errors));
    }
    for (const landing_page_url of invalidUrls) {
      assert.equal(validate({ creative_id: 'hero', landing_page_url }), false, relativePath);
    }
  }
});

test('sync additive assignments and assign operations validate landing pages without creative upserts', async () => {
  const validate = await compile(syncSchema);
  for (const field of ['assignments', 'assignment_operations']) {
    const assignment = { creative_id: 'hero', package_id: 'pkg_display' };
    if (field === 'assignment_operations') assignment.operation = 'assign';
    assert.equal(validate({ ...requestBase, [field]: [assignment] }), true, JSON.stringify(validate.errors));
    for (const landing_page_url of urls) {
      assert.equal(validate({ ...requestBase, [field]: [{ ...assignment, landing_page_url }] }), true,
        JSON.stringify(validate.errors));
    }
    for (const landing_page_url of invalidUrls) {
      assert.equal(validate({ ...requestBase, [field]: [{ ...assignment, landing_page_url }] }), false, field);
    }
  }
  for (const operation of ['unassign', 'replace']) {
    const assignment = { operation, creative_id: 'hero', package_id: 'pkg_display', landing_page_url: urls[0] };
    if (operation === 'replace') assignment.replaces_creative_id = 'old_hero';
    assert.equal(validate({ ...requestBase, assignment_operations: [assignment] }), false, operation);
  }
});

test('both assignment readback projections validate effective landing pages and allow no destination', async () => {
  for (const [schema, assignment] of [
    [listAssignment, { package_id: 'pkg_display', assigned_date: '2026-10-13T12:00:00Z' }],
    [buyAssignment, { creative_id: 'hero', approval_status: 'approved' }]
  ]) {
    const validate = await compile(schema);
    assert.equal(validate(assignment), true, JSON.stringify(validate.errors));
    for (const landing_page_url of urls) {
      assert.equal(validate({ ...assignment, landing_page_url }), true, JSON.stringify(validate.errors));
    }
    for (const landing_page_url of invalidUrls) {
      assert.equal(validate({ ...assignment, landing_page_url }), false);
    }
  }
});

test('assignment landing page capability defaults off and requires an explicit creative library when enabled', async () => {
  const creative = readSchema('protocol/get-adcp-capabilities-response.json').properties.creative;
  const capability = creative.properties.supports_assignment_landing_page;
  assert.equal(capability.default, false);
  assert.equal(capability['x-added-in'], '3.3.0');
  const validate = await compile(creative);
  for (const declaration of [
    {},
    { has_creative_library: true },
    { supports_assignment_landing_page: false },
    { supports_assignment_landing_page: false, has_creative_library: false },
    { supports_assignment_landing_page: true, has_creative_library: true }
  ]) {
    assert.equal(validate(declaration), true, JSON.stringify(validate.errors));
  }
  for (const declaration of [
    { supports_assignment_landing_page: true },
    { supports_assignment_landing_page: true, has_creative_library: false },
    { supports_assignment_landing_page: 'true', has_creative_library: true }
  ]) {
    assert.equal(validate(declaration), false, JSON.stringify(declaration));
  }
});

test('all input and readback fields use the creative click-through URL rules and carry 3.3 metadata', () => {
  const clickthroughUrl = readSchema('core/assets/url-asset.json').properties.url;
  for (const schema of [
    readSchema('core/creative-assignment.json'),
    syncSchema.properties.assignments.items,
    assignSchema,
    listAssignment,
    buyAssignment
  ]) {
    const landingPage = schema.properties.landing_page_url;
    assert.equal(landingPage.$ref, clickthroughUrl.$ref);
    assert.equal(landingPage['x-added-in'], '3.3.0');
    assert.equal(schema.required?.includes('landing_page_url') ?? false, false);
  }
});
