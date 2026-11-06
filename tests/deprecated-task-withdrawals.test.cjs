/**
 * Contract test for the 3.3-beta fields withdrawn from the deprecated tasks (adcp#8501).
 *
 * create_media_buy and update_media_buy are deprecated compatibility tasks, so 3.3 adds
 * nothing to them. Each field below is absent from their request and response schemas and
 * still lives on the live tasks named beside it. The schemas are open, so a seller on the
 * later schema ignores a withdrawn field like any unknown field.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const readSchema = (relative) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, relative), 'utf8'));
const readDoc = (relative) => fs.readFileSync(path.join(ROOT, 'docs', relative), 'utf8');

// True when any `properties` object in the schema declares `name` (prose mentions don't count).
function declares(node, name) {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => declares(child, name));
  if (node.properties && typeof node.properties === 'object' && Object.hasOwn(node.properties, name)) return true;
  return Object.values(node).some((child) => declares(child, name));
}

// True when any `dependencies` / `dependentRequired` map keys or lists `name`.
function dependsOn(node, name) {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => dependsOn(child, name));
  for (const key of ['dependencies', 'dependentRequired']) {
    const map = node[key];
    if (map && typeof map === 'object' && (Object.hasOwn(map, name) || Object.values(map).some((v) => Array.isArray(v) && v.includes(name)))) {
      return true;
    }
  }
  return Object.values(node).some((child) => dependsOn(child, name));
}

// A schema that no longer exists declares nothing (the get_products PR removes package-forecast-input).
const absent = (files, field) => {
  for (const file of files) {
    if (!fs.existsSync(path.join(SCHEMAS, file))) continue;
    assert.equal(declares(readSchema(file), field), false, `${file} declares ${field}`);
  }
};
const present = (file, pick, field) => {
  assert.ok(pick(readSchema(file)).properties[field], `${file} keeps ${field}`);
};

const CREATE = 'media-buy/create-media-buy-request.json';
const UPDATE = 'media-buy/update-media-buy-request.json';

test('lineage is off create_media_buy and stays on the live tasks and readback', () => {
  const create = readSchema(CREATE);
  for (const field of ['predecessor_media_buy_id', 'lineage_reason']) {
    assert.equal(create.properties[field], undefined, field);
    assert.equal(dependsOn(create, field), false, `${field} dependency`);
    assert.equal(declares(readSchema(UPDATE), field), false, `update ${field}`);
  }
  for (const file of ['media-buy/buy-products-request.json', 'media-buy/accept-proposal-request.json', 'core/media-buy.json']) {
    for (const field of ['predecessor_media_buy_id', 'lineage_reason']) present(file, (s) => s, field);
  }
  const item = readSchema('media-buy/get-media-buys-response.json').properties.media_buys.items;
  for (const field of ['predecessor_media_buy_id', 'lineage_reason']) assert.ok(item.properties[field], field);
  assert.ok(readSchema('media-buy/get-media-buys-request.json').properties.predecessor_media_buy_id, 'get_media_buys filter');
});

test('artifact_webhook.signing_profile is withdrawn; signing_profile stays on the live webhook configs', () => {
  const webhook = readSchema(CREATE).properties.artifact_webhook;
  assert.equal(webhook.properties.signing_profile, undefined);
  assert.equal(JSON.stringify(webhook.not || null).includes('signing_profile'), false);
  // The notification-config copies are a separate #8501 decision, so they are not asserted here.
  for (const file of [
    'core/push-notification-config.json',
    'core/reporting-webhook.json',
  ]) {
    present(file, (s) => s, 'signing_profile');
  }
});

test('start_requires_all_creatives_approved is off create/update packages and stays on control and readback', () => {
  const field = 'start_requires_all_creatives_approved';
  absent([
    'media-buy/package-request.json',
    'media-buy/package-update.json',
    'core/package.json',
    'media-buy/package-forecast-input.json',
    CREATE,
    UPDATE,
    'media-buy/create-media-buy-response.json',
    'media-buy/update-media-buy-response.json',
  ], field);
  present('media-buy/package-control.json', (s) => s, field);
  const readback = readSchema('media-buy/get-media-buys-response.json').properties.media_buys.items.properties.packages.items;
  assert.ok(readback.properties[field], 'get_media_buys package readback');
  assert.ok(readSchema('core/media-buy-features.json').properties.creative_start_policy, 'creative_start_policy feature');
  assert.ok(readSchema('core/media-buy-available-action-id.json').enumMetadata.update_creative_start_policy);
});

test('target_audiences is off create/update packages', () => {
  const request = readSchema('media-buy/package-request.json');
  assert.equal(request.properties.target_audiences, undefined);
  assert.equal(dependsOn(request, 'target_audiences'), false);
  absent(['media-buy/package-forecast-input.json', 'media-buy/package-update.json', 'core/package.json', CREATE, UPDATE], 'target_audiences');
  // core/product-filters.json (get_products) is deliberately not asserted here.
});

test('assignment trackers and landing page are off the create/update assignment row and stay on sync and readback', () => {
  const row = readSchema('core/creative-assignment.json');
  assert.equal(row.properties.trackers, undefined);
  assert.equal(row.properties.landing_page_url, undefined);
  for (const file of ['media-buy/package-request.json', 'media-buy/package-update.json', 'core/package.json']) {
    assert.equal(readSchema(file).properties.creative_assignments.items.$ref, '/schemas/core/creative-assignment.json', file);
  }
  const assign = readSchema('creative/sync-creatives-request.json').properties.assignment_operations.items.oneOf
    .find((variant) => variant.properties.operation.const === 'assign');
  assert.ok(assign.properties.trackers && assign.properties.landing_page_url, 'sync_creatives assign operation');
  const listed = readSchema('creative/list-creatives-response.json').properties.creatives.items.properties.assignments.properties.assigned_packages.items;
  const bought = readSchema('media-buy/get-media-buys-response.json').properties.media_buys.items.properties.packages.items.properties.creative_approvals.items;
  for (const [name, readback] of [['list_creatives', listed], ['get_media_buys', bought]]) {
    assert.ok(readback.properties.trackers && readback.properties.landing_page_url, `${name} readback`);
  }
});

test('billing_measurement.counting_mechanisms is gone everywhere, and the enum stays for provenance', () => {
  absent([
    'core/measurement-terms.json',
    'core/product.json',
    'media-buy/package-request.json',
    'media-buy/package-update.json',
    'core/package.json',
    CREATE,
    UPDATE,
  ], 'counting_mechanisms');
  assert.equal(readSchema('core/measurement-terms.json').properties.billing_measurement.properties.counting_mechanisms, undefined);
  assert.ok(fs.existsSync(path.join(SCHEMAS, 'enums/collection-mechanism.json')));
  assert.equal(
    readSchema('core/vendor-metric-provenance.json').properties.mechanisms.items.$ref,
    '/schemas/enums/collection-mechanism.json',
  );
});

test('the 4.0 registry still carries the withdrawn designs', () => {
  const registry = yaml.load(fs.readFileSync(
    path.join(ROOT, 'static/compliance/source/universal/v4-compatibility.yaml'), 'utf8'));
  for (const id of ['purchase_target_audiences_required_in_4_0', 'canonical_counting_mechanisms_required_in_4_0']) {
    assert.ok(registry.checks.find((entry) => entry.id === id), `${id} is registered`);
  }
});

test('the release story names the fields withdrawn from the deprecated tasks', () => {
  for (const page of [
    'reference/release-notes.mdx',
    'reference/whats-new-in-3-3.mdx',
    'reference/migration/3-2-to-3-3.mdx',
    'reference/3-3-beta.mdx',
  ]) {
    assert.match(readDoc(page), /^#{2,4} Withdrawn from the deprecated tasks\s*$/m, page);
  }
});
