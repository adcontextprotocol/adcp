/**
 * Contract test for assigning a creative to specific installments of a package
 * (experimental media_buy.installment_creative_assignment, adcp#8968).
 *
 * `installment_refs` rides on the sync_creatives `assign` and `replace` operations and
 * reads back on get_media_buys and list_creatives. Absent means every installment. It is
 * gated on the experimental feature id because an older seller would ignore it and run the
 * creative on every installment (versioning rule 4), and it stays off the deprecated
 * create_media_buy / update_media_buy assignment rows and the deprecated assignments[] row.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'static/schemas/source');
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

const FEATURE = 'media_buy.installment_creative_assignment';
const collection_ref = { publisher_domain: 'creatorloop.example', collection_id: 'creatorloop_channel_juniper_vale' };
const slot = n => ({ collection_ref, installment_id: `juniper_vale_slot_${n}` });
const requestBase = { account: { account_id: 'acct_acme' }, idempotency_key: 'installment-assignment-test-0001' };
const assignment = { creative_id: 'juniper_offer_brief', package_id: 'pkg_juniper_vale' };
const request = operation => ({ ...requestBase, assignment_operations: [operation] });
const assign = { operation: 'assign', ...assignment };
const replace = { operation: 'replace', ...assignment, replaces_creative_id: 'juniper_awareness_brief' };

const listCreatives = row => ({
  status: 'completed', query_summary: { total_matching: 1, returned: 1 }, pagination: { has_more: false },
  creatives: [{ creative_id: 'juniper_offer_brief', name: 'Offer brief', format_kind: 'image', status: 'approved',
    created_date: '2026-11-13T12:00:00Z', updated_date: '2026-11-13T12:00:00Z',
    assignments: { assignment_count: 1, returned_assignment_count: 1, assignments_truncated: false,
      assigned_packages: [{ package_id: 'pkg_juniper_vale', assigned_date: '2026-11-13T12:00:00Z', ...row }] } }]
});
const getMediaBuys = row => ({
  status: 'completed', media_buys: [{ media_buy_id: 'mb_juniper', status: 'active', currency: 'USD',
    total_budget: 1000, confirmed_at: '2026-11-13T12:00:00Z', revision: 1,
    packages: [{ package_id: 'pkg_juniper_vale',
      creative_approvals: [{ creative_id: 'juniper_offer_brief', approval_status: 'approved', ...row }] }] }]
});
const readbacks = [
  ['creative/list-creatives-response.json', listCreatives],
  ['media-buy/get-media-buys-response.json', getMediaBuys]
];

const nodes = () => {
  const ops = readSchema('creative/sync-creatives-request.json').properties.assignment_operations.items.oneOf;
  const variant = name => ops.find(v => v.properties.operation.const === name);
  return {
    variant,
    fields: [
      ['assign', variant('assign').properties.installment_refs],
      ['replace', variant('replace').properties.installment_refs],
      ['get_media_buys', readSchema('media-buy/get-media-buys-response.json').properties.media_buys.items
        .properties.packages.items.properties.creative_approvals.items.properties.installment_refs],
      ['list_creatives', readSchema('creative/list-creatives-response.json').properties.creatives.items
        .properties.assignments.properties.assigned_packages.items.properties.installment_refs]
    ]
  };
};

test('assign and replace accept installment_refs, and accept their absence', async () => {
  const validate = await compile('creative/sync-creatives-request.json');
  for (const operation of [assign, replace]) {
    assert.equal(validate(request(operation)), true, JSON.stringify(validate.errors));
    assert.equal(validate(request({ ...operation, installment_refs: [slot(2)] })), true, JSON.stringify(validate.errors));
    assert.equal(validate(request({ ...operation, installment_refs: [slot(1), slot(2)], placement_ids: ['post'] })), true,
      JSON.stringify(validate.errors));
  }
});

test('the sync_creatives creator example validates against the source schema', async () => {
  // The example carries no $schema: sync-creatives-request.json is released in v3,
  // which lacks installment_refs, so this test is its validator.
  const doc = fs.readFileSync(path.join(ROOT, 'docs/creative/task-reference/sync_creatives.mdx'), 'utf8');
  const section = doc.slice(doc.indexOf('### Assigning to specific installments (experimental)'));
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'the section carries a JSON example');
  const example = JSON.parse(block[1]);
  assert.deepEqual(example.assignment_operations.map(op => op.installment_refs.map(ref => ref.installment_id)),
    [['juniper_vale_slot_1'], ['juniper_vale_slot_2']]);
  const validate = await compile('creative/sync-creatives-request.json');
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
});

test('installment_refs are unique, nonempty, bounded canonical refs', async () => {
  const validate = await compile('creative/sync-creatives-request.json');
  const many = Array.from({ length: 500 }, (_, i) => slot(i + 1));
  for (const operation of [assign, replace]) {
    assert.equal(validate(request({ ...operation, installment_refs: many })), true, JSON.stringify(validate.errors));
    for (const installment_refs of [
      [slot(1), slot(1)],
      [],
      [...many, slot(501)],
      null,
      [{ installment_id: 'juniper_vale_slot_1' }],
      [{ collection_ref: { collection_id: collection_ref.collection_id }, installment_id: 'juniper_vale_slot_1' }],
      [{ ...slot(1), name: 'Post one' }],
      [{ collection_ref: { ...collection_ref, kind: 'creator' }, installment_id: 'juniper_vale_slot_1' }],
      [{ ...slot(1), installment_id: '' }],
      ['juniper_vale_slot_1']
    ]) {
      assert.equal(validate(request({ ...operation, installment_refs })), false, JSON.stringify(installment_refs)?.slice(0, 120));
    }
  }
  for (const [schema, wrap] of readbacks) {
    const readback = await compile(schema);
    assert.equal(readback(wrap({ installment_refs: [slot(1), slot(1)] })), false, `${schema} duplicate`);
    assert.equal(readback(wrap({ installment_refs: [] })), false, `${schema} empty`);
  }
});

test('unassign and merge reject installment_refs by name', async () => {
  const validate = await compile('creative/sync-creatives-request.json');
  const unassign = { operation: 'unassign', ...assignment };
  const merge = { operation: 'merge', ...assignment, merged_creative_id: 'seller_copy_1' };
  for (const operation of [unassign, merge]) {
    assert.equal(validate(request(operation)), true, JSON.stringify(validate.errors));
    assert.equal(validate(request({ ...operation, installment_refs: [slot(1)] })), false, operation.operation);
  }
});

test('get_media_buys and list_creatives read the scope back; absent means every installment', async () => {
  for (const [schema, wrap] of readbacks) {
    const validate = await compile(schema);
    assert.equal(validate(wrap({})), true, `${schema}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate(wrap({ installment_refs: [slot(1), slot(2)] })), true, `${schema}: ${JSON.stringify(validate.errors)}`);
  }
});

test('every installment_refs node is experimental, new in 3.3, and matches the write shape', () => {
  const { fields } = nodes();
  const [, write] = fields[0];
  for (const [name, node] of fields) {
    assert.ok(node, `${name} declares installment_refs`);
    assert.equal(node['x-status'], 'experimental', name);
    assert.equal(node['x-added-in'], '3.3.0', name);
    assert.equal(node.items.$ref, '/schemas/core/canonical-installment-ref.json', name);
    for (const key of ['type', 'minItems', 'maxItems', 'uniqueItems']) assert.equal(node[key], write[key], `${name} ${key}`);
    assert.match(node.description, new RegExp(FEATURE.replace('.', '\\.')), `${name} names the feature id`);
  }
  // The product's installments cap at 500, so a scope can always name all of them.
  assert.equal(write.maxItems, readSchema('core/canonical-product.json').properties.installments.maxItems);
});

test('the capability gate: buyers send it only to sellers listing the feature, which reject it otherwise', async () => {
  const { fields } = nodes();
  for (const [name, node] of fields.slice(0, 2)) {
    assert.match(node.description, /Buyers MUST NOT send this field unless the seller lists media_buy\.installment_creative_assignment in experimental_features|installment, cutoff and capability rules of assign/, name);
  }
  const [, write] = fields[0];
  assert.match(write.description, /MUST reject it with UNSUPPORTED_FEATURE/);
  // The seller rules use existing codes only.
  assert.match(write.description, /VALIDATION_ERROR/);
  assert.match(write.description, /CREATIVE_DEADLINE_EXCEEDED/);
  const codes = readSchema('enums/error-code.json').enum;
  for (const code of ['VALIDATION_ERROR', 'CREATIVE_DEADLINE_EXCEEDED', 'UNSUPPORTED_FEATURE']) assert.ok(codes.includes(code), code);

  const featureId = await compile('core/experimental-feature-id.json');
  assert.equal(featureId(FEATURE), true, JSON.stringify(featureId.errors));
  const capabilities = await compile('protocol/get-adcp-capabilities-response.json');
  assert.equal(capabilities({
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['media_buy'],
    experimental_features: [FEATURE]
  }), true, JSON.stringify(capabilities.errors));

  const registry = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
  const row = registry.split('\n').find(line => line.startsWith(`| \`${FEATURE}\` |`));
  assert.ok(row, `experimental-status lists ${FEATURE}`);
  for (const surface of ['installment_refs', 'sync_creatives', 'get_media_buys', 'list_creatives', '#8968']) {
    assert.ok(row.includes(surface), `registry row names ${surface}`);
  }
});

test('installment_refs stays off the deprecated assignment rows', () => {
  const declares = node => node !== null && typeof node === 'object' && (
    Array.isArray(node) ? node.some(declares)
      : (node.properties && Object.hasOwn(node.properties, 'installment_refs')) || Object.values(node).some(declares));
  for (const file of [
    'core/creative-assignment.json',
    'media-buy/package-request.json',
    'media-buy/package-update.json',
    'core/package.json',
    'media-buy/create-media-buy-request.json',
    'media-buy/update-media-buy-request.json'
  ]) {
    assert.equal(declares(readSchema(file)), false, `${file} declares installment_refs`);
  }
  const deprecatedRow = readSchema('creative/sync-creatives-request.json').properties.assignments.items;
  assert.equal(deprecatedRow.properties.installment_refs, undefined, 'deprecated sync_creatives assignments[] row');
});
