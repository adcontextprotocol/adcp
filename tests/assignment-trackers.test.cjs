const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_DIR = path.join(__dirname, '../static/schemas/source');
const DOCS_DIR = path.join(__dirname, '../docs');
const FEATURE_ID = 'creative.assignment_trackers';

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
const requestBase = {
  account: { account_id: 'acct_acme' },
  idempotency_key: 'assignment-trackers-0001'
};
const trackers = [
  { asset_type: 'pixel_tracker', event: 'impression', url: 'https://t.example/imp?mb=mb_1&pkg=pkg_1&cb={CACHEBUSTER}' },
  { asset_type: 'pixel_tracker', event: 'click', method: 'img', url: 'https://t.example/click?mb=mb_1' },
  { asset_type: 'pixel_tracker', event: 'custom', custom_event_name: 'start', url: 'https://t.example/start?mb=mb_1' }
];
const invalidTrackers = [
  [],
  null,
  {},
  [{ asset_type: 'pixel_tracker', event: 'impression' }],
  [{ asset_type: 'pixel_tracker', event: 'custom', url: 'https://t.example/x' }],
  [{ asset_type: 'pixel_tracker', event: 'impression', url: 'not a URL with spaces' }],
  [{ event: 'impression', url: 'https://t.example/x' }],
  ['https://t.example/imp']
];

test('every assignment surface references pixel_tracker and carries experimental 3.3 metadata', () => {
  for (const schema of [
    readSchema('core/creative-assignment.json'),
    syncSchema.properties.assignments.items,
    assignSchema,
    listAssignment,
    buyAssignment
  ]) {
    const field = schema.properties.trackers;
    assert.equal(field.type, 'array');
    assert.equal(field.minItems, 1);
    assert.equal(field.items.$ref, '/schemas/core/assets/pixel-tracker-asset.json');
    assert.equal(field['x-status'], 'experimental');
    assert.equal(field['x-added-in'], '3.3.0');
    assert.equal(schema.required?.includes('trackers') ?? false, false);
    assert.match(field.description, new RegExp(FEATURE_ID.replace('.', '\\.')));
  }
});

test('input descriptions state the slot-limit, rejection, and unsupported-feature rules', () => {
  for (const schema of [
    readSchema('core/creative-assignment.json'),
    syncSchema.properties.assignments.items,
    assignSchema
  ]) {
    const description = schema.properties.trackers.description;
    assert.match(description, /quantity\.max/);
    assert.match(description, /MUST NOT silently drop/);
    assert.match(description, /UNSUPPORTED_FEATURE/);
    assert.match(description, /never replace them/);
    assert.match(description, /any `pixel_tracker` event/);
    assert.match(description, /comes only from|come only from/);
  }
});

test('package create, update, and read assignments validate trackers', async () => {
  for (const relativePath of ['media-buy/package-request.json', 'media-buy/package-update.json', 'core/package.json']) {
    const assignment = readSchema(relativePath).properties.creative_assignments.items;
    assert.equal(assignment.$ref, '/schemas/core/creative-assignment.json');
    const validate = await compile(assignment);
    assert.equal(validate({ creative_id: 'hero' }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ creative_id: 'hero', trackers }), true, JSON.stringify(validate.errors));
    for (const bad of invalidTrackers) {
      assert.equal(validate({ creative_id: 'hero', trackers: bad }), false, `${relativePath}: ${JSON.stringify(bad)}`);
    }
  }
});

test('sync additive assignments and assign operations validate trackers without creative upserts', async () => {
  const validate = await compile(syncSchema);
  for (const field of ['assignments', 'assignment_operations']) {
    const assignment = { creative_id: 'hero', package_id: 'pkg_display' };
    if (field === 'assignment_operations') assignment.operation = 'assign';
    assert.equal(validate({ ...requestBase, [field]: [assignment] }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...requestBase, [field]: [{ ...assignment, trackers }] }), true,
      JSON.stringify(validate.errors));
    assert.equal(validate({
      ...requestBase,
      [field]: [{ ...assignment, landing_page_url: 'https://example.com/offer', trackers }]
    }), true, JSON.stringify(validate.errors));
    for (const bad of invalidTrackers) {
      assert.equal(validate({ ...requestBase, [field]: [{ ...assignment, trackers: bad }] }), false,
        `${field}: ${JSON.stringify(bad)}`);
    }
  }
  for (const operation of ['unassign', 'replace']) {
    const assignment = { operation, creative_id: 'hero', package_id: 'pkg_display', trackers };
    if (operation === 'replace') assignment.replaces_creative_id = 'old_hero';
    assert.equal(validate({ ...requestBase, assignment_operations: [assignment] }), false, operation);
  }
});

test('the atomic unassign/assign reset stays valid and an assign can omit trackers', async () => {
  const validate = await compile(syncSchema);
  const assignment = { creative_id: 'hero', package_id: 'pkg_display' };
  assert.equal(validate({
    ...requestBase,
    assignment_operations: [
      { operation: 'unassign', ...assignment },
      { operation: 'assign', ...assignment, weight: 50 }
    ]
  }), true, JSON.stringify(validate.errors));
});

test('complete list/get responses validate assignment trackers readback', async () => {
  for (const [schema, assignment] of [
    [listAssignment, { package_id: 'pkg_display', assigned_date: '2026-10-13T12:00:00Z' }],
    [buyAssignment, { creative_id: 'hero', approval_status: 'approved' }]
  ]) {
    const validate = await compile(schema);
    assert.equal(validate(assignment), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...assignment, trackers }), true, JSON.stringify(validate.errors));
    for (const bad of invalidTrackers) {
      assert.equal(validate({ ...assignment, trackers: bad }), false, JSON.stringify(bad));
    }
  }
});

test('trackers capability defaults off, requires a creative library, and requires the experimental feature id', async () => {
  const capabilities = readSchema('protocol/get-adcp-capabilities-response.json');
  const creative = capabilities.properties.creative;
  const capability = creative.properties.supports_assignment_trackers;
  assert.equal(capability.default, false);
  assert.equal(capability['x-added-in'], '3.3.0');
  assert.equal(capability['x-status'], 'experimental');
  assert.match(capability.description, new RegExp(FEATURE_ID.replace('.', '\\.')));
  // The sibling landing-page field from the same family is not experimental.
  assert.equal(creative.properties.supports_assignment_landing_page['x-status'], undefined);

  const validate = await compile(creative);
  for (const declaration of [
    {},
    { has_creative_library: true },
    { supports_assignment_trackers: false },
    { supports_assignment_trackers: false, has_creative_library: false },
    { supports_assignment_trackers: true, has_creative_library: true }
  ]) {
    assert.equal(validate(declaration), true, JSON.stringify(validate.errors));
  }
  for (const declaration of [
    { supports_assignment_trackers: true },
    { supports_assignment_trackers: true, has_creative_library: false },
    { supports_assignment_trackers: 'true', has_creative_library: true }
  ]) {
    assert.equal(validate(declaration), false, JSON.stringify(declaration));
  }

  const gate = capabilities.allOf.find(clause => clause.if?.properties?.creative?.properties?.supports_assignment_trackers);
  assert.ok(gate, 'top-level allOf gates the capability on experimental_features');
  assert.equal(gate.then.properties.experimental_features.contains.const, FEATURE_ID);
  assert.deepEqual(gate.then.required, ['experimental_features']);
});

test('the experimental feature id is listed in the experimental status reference', () => {
  const page = fs.readFileSync(path.join(DOCS_DIR, 'reference/experimental-status.mdx'), 'utf8');
  assert.match(page, new RegExp(`^\\| \`${FEATURE_ID.replace('.', '\\.')}\` \\|`, 'm'));
});

test('docs describe additive semantics, slot limits, reset, and merge without enumerating events', () => {
  const sync = fs.readFileSync(path.join(DOCS_DIR, 'creative/task-reference/sync_creatives.mdx'), 'utf8');
  const start = sync.indexOf('### Assignment trackers (experimental)');
  assert.notEqual(start, -1);
  const section = sync.slice(start, sync.indexOf('### Creative object', start));
  for (const pattern of [
    /never replace them/,
    /`quantity\.max`/,
    /MUST NOT silently drop any/,
    /UNSUPPORTED_FEATURE/,
    /any `pixel_tracker` event/,
    /creative\.assignment_trackers/,
    /unassign` then `assign`/,
    /After an assignment `merge`, trackers come only from the buyer's assignment/
  ]) {
    assert.match(section, pattern);
  }
  assert.doesNotMatch(section, /viewable_mrc|audible_video_complete/);
});
