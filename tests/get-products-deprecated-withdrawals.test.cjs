/**
 * Contract test for the fields withdrawn from the deprecated get_products
 * facade and the price_adjustments table withdrawn to 4.0 (adcp#8501).
 *
 * get_products is deprecated for new integrations in 3.2, so 3.3 does not grow
 * it. The experimental refine[].package, include_collections / collections,
 * include_execution_readiness / execution_readiness, filters.target_audiences
 * and refinement_applied resolution fields leave its schemas; the readiness
 * flag and map live on list_products, and collections stay on list_products,
 * request_proposals and refine_proposals. The experimental price_adjustments
 * table leaves every pricing option. sync_creatives assignments[] rows lose
 * trackers and landing_page_url; assignment_operations assign keeps both. This
 * test fails if any withdrawn field returns, and checks the 4.0 registry says
 * where the designs went.
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
const exists = (relative) => fs.existsSync(path.join(SCHEMAS, relative));
const registryChecks = () => {
  const registry = yaml.load(fs.readFileSync(path.join(ROOT, 'static/compliance/source/universal/v4-compatibility.yaml'), 'utf8'));
  const list = registry.checks ?? registry.items ?? Object.values(registry).find(Array.isArray);
  assert.ok(Array.isArray(list), 'the registry lists its checks');
  return list;
};

const PRICING_OPTIONS = ['cpm', 'vcpm', 'cpc', 'cpcv', 'cpv', 'cpp', 'flat-rate'];

test('get_products request no longer declares the withdrawn fields', () => {
  const request = readSchema('media-buy/get-products-request.json');
  assert.equal(request.properties.include_collections, undefined);
  assert.equal(request.properties.include_execution_readiness, undefined);

  const refine = request.properties.refine.items;
  const scopes = refine.oneOf.map((arm) => arm.properties.scope.const);
  assert.deepEqual(scopes, ['request', 'product', 'proposal'], 'refine[].package is withdrawn');
  assert.equal(JSON.stringify(refine).includes('package-forecast-input'), false);

  const filters = readSchema('core/product-filters.json');
  assert.equal(filters.properties.target_audiences, undefined);
  assert.equal(filters.dependencies?.target_audiences, undefined);
});

test('get_products response and rejection no longer declare the withdrawn fields', () => {
  const response = readSchema('media-buy/get-products-response.json');
  assert.equal(response.properties.collections, undefined);
  assert.equal(response.properties.execution_readiness, undefined);
  assert.equal(response.dependencies?.collections, undefined);
  assert.equal(response.dependencies?.execution_readiness, undefined);

  for (const arm of response.properties.refinement_applied.items.oneOf) {
    for (const field of ['result_product_id', 'resolved_start_time', 'resolved_end_time']) {
      assert.equal(arm.properties[field], undefined, `refinement_applied ${field}`);
    }
  }

  const rejected = readSchema('media-buy/get-products-rejected.json');
  assert.equal(rejected.properties.collections, undefined);
});

test('the withdrawn files are deleted', () => {
  for (const file of [
    'media-buy/package-forecast-input.json',
    'pricing-options/price-adjustments.json',
    'error-details/price-adjustments-mismatch.json',
  ]) {
    assert.equal(exists(file), false, `${file} is withdrawn`);
  }
  assert.equal(
    fs.existsSync(path.join(ROOT, 'static/compliance/source/test-vectors/price-adjustments')),
    false,
    'the price_adjustments test vectors are withdrawn',
  );
  assert.equal(fs.existsSync(path.join(ROOT, 'tests/price-adjustments-vectors.test.cjs')), false);
});

test('list_products carries the execution readiness flag and map as experimental', () => {
  const request = readSchema('media-buy/list-products-request.json');
  const flag = request.properties.include_execution_readiness;
  assert.ok(flag, 'list_products takes include_execution_readiness');
  assert.equal(flag['x-status'], 'experimental');
  assert.equal(flag.type, 'boolean');

  const response = readSchema('media-buy/list-products-response.json');
  const map = response.properties.execution_readiness;
  assert.ok(map, 'list_products returns execution_readiness');
  assert.equal(map['x-status'], 'experimental');
  assert.deepEqual(response.dependencies.execution_readiness, ['products'], 'never on an unchanged outcome');
});

test('collections stay on list_products, request_proposals and refine_proposals', () => {
  for (const file of ['list-products', 'request-proposals', 'refine-proposals']) {
    assert.ok(readSchema(`media-buy/${file}-response.json`).properties.collections, `${file} response keeps collections`);
    assert.ok(readSchema(`media-buy/${file}-request.json`).properties.include_collections, `${file} request keeps include_collections`);
  }
});

test('no pricing option declares price_adjustments', () => {
  for (const option of PRICING_OPTIONS) {
    const file = `pricing-options/${option}-option.json`;
    const schema = readSchema(file);
    assert.equal(schema.properties.price_adjustments, undefined, file);
    assert.equal(schema.dependencies?.price_adjustments, undefined, file);
    assert.equal(JSON.stringify(schema).includes('price_adjustments'), false, `${file} still mentions price_adjustments`);
  }
  assert.equal(
    JSON.stringify(readSchema('core/product.json')).includes('price_adjustments'),
    false,
    'product.json no longer ties price_adjustments rows to overlay_support',
  );
});

test('sync_creatives assignments[] rows no longer carry trackers or landing_page_url', () => {
  const request = readSchema('creative/sync-creatives-request.json');
  const row = request.properties.assignments.items;
  assert.equal(row.additionalProperties, false, 'the legacy row stays closed');
  assert.equal(row.properties.trackers, undefined);
  assert.equal(row.properties.landing_page_url, undefined);

  const assign = request.properties.assignment_operations.items.oneOf
    .find((arm) => arm.properties.operation?.const === 'assign');
  assert.ok(assign, 'assignment_operations keeps an assign arm');
  assert.ok(assign.properties.trackers, 'assign keeps trackers');
  assert.ok(assign.properties.landing_page_url, 'assign keeps landing_page_url');
});

test('the 4.0 registry says where the withdrawn designs went', () => {
  const checks = new Map(registryChecks().map((check) => [String(check.id), check]));
  assert.ok(checks.has('canonical_price_adjustments_required_in_4_0'), 'a price_adjustments entry');
  // filters.target_audiences is covered by the purchase-path entry, whose fix says it left get_products.
  const targets = checks.get('purchase_target_audiences_required_in_4_0');
  assert.ok(targets, 'the target_audiences entry');
  assert.match(String(targets.fix), /get_products/);
});
