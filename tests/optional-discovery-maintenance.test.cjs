'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The maintained application uses SDK 9.6.2. Do not mistake the separate
// fixture-test-sdk's newer runner for proof that this production pin works.
const sdkModule = process.env.ADCP_MAINTENANCE_SDK_TEST_MODULE || '@adcp/sdk/testing';
const { runStoryboard, parseStoryboard } = require(sdkModule);
const sdkPackage = path.resolve(path.dirname(require.resolve(sdkModule)), '../../../package.json');
const sourceRoot = path.join(__dirname, '../static/compliance/source');
const load = relative => parseStoryboard(fs.readFileSync(path.join(sourceRoot, relative), 'utf8'));
const scenario = name => load(`protocols/media-buy/scenarios/${name}.yaml`);

function options(client) {
  const tools = ['get_products', 'create_media_buy', 'update_media_buy', 'sync_creatives', 'comply_test_controller'];
  return {
    protocol: 'mcp',
    _serverAdcpVersion: '3.1.31',
    schemaRoot: path.join(__dirname, '../dist/schemas/3.1.31'),
    agentTools: tools,
    _profile: { tools, raw_capabilities: { creative: { has_creative_library: true } } },
    _controllerCapabilities: { detected: true, scenarios: ['seed_product', 'seed_pricing_option', 'seed_account'] },
    _client: client,
  };
}

test('the maintained production runner reports unsupported exclusion coverage before mutations', async () => {
  assert.equal(JSON.parse(fs.readFileSync(sdkPackage, 'utf8')).version, '9.6.2');
  let calls = 0;
  const result = await runStoryboard('https://seller.example/mcp', scenario('product_filter_behavior'), options({
    resetContext() {},
    async executeTask() { calls++; throw new Error('unsupported coverage must not seed'); },
    async getProducts() { calls++; throw new Error('unsupported coverage must not discover'); },
  }));
  assert.equal(result.passed_count, 0);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.match(JSON.stringify(result), /field_excludes_runner/);
  assert.equal(calls, 0);
});

test('a creative library alone does not run provenance mutations on the maintained wire', async () => {
  for (const name of ['provenance_enforcement', 'provenance_truth_of_claim', 'provenance_audit_observation']) {
    let calls = 0;
    const result = await runStoryboard('https://seller.example/mcp', scenario(name), options({
      resetContext() {},
      async executeTask() { calls++; throw new Error('unsupported provenance must not seed'); },
      async getProducts() { calls++; throw new Error('unsupported provenance must not discover'); },
      async syncCreatives() { calls++; throw new Error('unsupported provenance must not submit'); },
    }));
    assert.equal(result.passed_count, 0, name);
    assert.equal(result.failed_count, 0, name);
    assert.equal(result.skipped_count, 1, name);
    assert.match(JSON.stringify(result), /supports_provenance/);
    assert.equal(calls, 0, name);
  }
});

test('SDK 9.6.2 grades fixture-backed auction discovery, buyer bids, and budget-only updates without guidance', async () => {
  const storyboard = load('specialisms/sales-non-guaranteed/index.yaml');
  const phases = storyboard.phases.filter(phase => ['get_products_brief', 'create_media_buy', 'update_media_buy']
    .some(id => phase.steps.some(step => step.id === id)));
  storyboard.phases = phases.map(phase => ({ ...phase, steps: phase.steps.filter(step =>
    ['get_products_brief', 'create_media_buy', 'update_media_buy'].includes(step.id)) }));
  // Preload the controller-backed catalog and isolate these three real runner
  // steps. This is construction/grading coverage, not a substitute for the
  // independent response-schema and upstream-traffic integration suites.
  delete storyboard.prerequisites;
  delete storyboard.fixtures;
  delete storyboard.invariants;
  for (const phase of storyboard.phases) for (const step of phase.steps) {
    step.validations = step.validations.filter(validation =>
      !['response_schema', 'upstream_traffic'].includes(validation.check));
  }
  const display = {
    product_id: 'sports_display_auction', delivery_type: 'non_guaranteed',
    format_ids: [{ id: 'display_300x250', agent_url: 'https://seller.example/mcp' }],
    pricing_options: [{ pricing_option_id: 'cpm_auction', pricing_model: 'cpm', currency: 'USD', floor_price: 5 }],
  };
  const video = {
    product_id: 'outdoor_video_auction', delivery_type: 'non_guaranteed',
    format_ids: [{ id: 'video_30s', agent_url: 'https://seller.example/mcp' }],
    pricing_options: [{ pricing_option_id: 'cpm_auction', pricing_model: 'cpm', currency: 'USD', floor_price: 15 }],
  };
  let created;
  let updated;
  const runOptions = options({
    resetContext() {},
    async getProducts(request) {
      assert.equal(request.account.sandbox, true);
      return { success: true, data: {
        // Unrelated inventory can precede both fixtures and have a higher floor.
        products: [{ product_id: 'unrelated-first', pricing_options: [{ pricing_model: 'cpm', floor_price: 1000 }] }, video, display],
        context: request.context,
      } };
    },
    async createMediaBuy(request) {
      assert.equal(request.account.sandbox, true);
      created = structuredClone(request);
      assert.deepEqual(request.packages.map(pkg => [pkg.product_id, pkg.pricing_option_id, pkg.bid_price]), [
        ['sports_display_auction', 'cpm_auction', 6],
        ['outdoor_video_auction', 'cpm_auction', 16],
      ]);
      return { success: true, data: {
        media_buy_id: 'fixture-buy', revision: 1, status: 'active', confirmed_at: '2026-01-01T00:00:00Z',
        packages: request.packages.map((pkg, index) => ({ ...pkg, package_id: `pkg_${index}` })),
        context: request.context,
      } };
    },
    async updateMediaBuy(request) {
      assert.equal(request.account.sandbox, true);
      updated = structuredClone(request);
      assert.ok(request.packages.every(pkg => pkg.bid_price === undefined));
      return { success: true, data: {
        media_buy_id: 'fixture-buy', revision: 2, media_buy_status: 'active',
        affected_packages: created.packages.map((pkg, index) => ({
          ...pkg, package_id: `pkg_${index}`, budget: request.packages[index].budget,
        })),
        context: request.context,
      } };
    },
  });
  runOptions.brand = { domain: 'acmeoutdoor.example' };
  const result = await runStoryboard('https://seller.example/mcp', storyboard, runOptions);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.passed_count, 3, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.deepEqual(updated.packages.map(pkg => pkg.budget), [12000, 13000]);
});
