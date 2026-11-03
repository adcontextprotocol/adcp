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

function auctionSteps() {
  const storyboard = load('specialisms/sales-non-guaranteed/index.yaml');
  const phases = storyboard.phases.filter(phase => ['get_products_brief', 'create_media_buy', 'update_media_buy']
    .some(id => phase.steps.some(step => step.id === id)));
  storyboard.phases = phases.map(phase => ({ ...phase, steps: phase.steps.filter(step =>
    ['get_products_brief', 'create_media_buy', 'update_media_buy'].includes(step.id)) }));
  // Isolate request construction from fixture/preflight and transport checks.
  // The modern SDK's actual MCP lifecycle regression retains those checks.
  delete storyboard.prerequisites;
  delete storyboard.fixtures;
  delete storyboard.invariants;
  for (const phase of storyboard.phases) for (const step of phase.steps) {
    step.validations = step.validations.filter(validation =>
      !['response_schema', 'upstream_traffic'].includes(validation.check));
  }
  return storyboard;
}

test('SDK 9.6.2 cannot construct the maintained wholesale discovery and stops subsequent auction mutations', async () => {
  const storyboard = auctionSteps();
  let discovery;
  let mutations = 0;
  const runOptions = options({
    resetContext() {},
    async getProducts(request) {
      discovery = structuredClone(request);
      // SDK 9 injects this brief even though the authored wholesale request
      // omits it. A strict 3.1 seller must refuse the malformed combination.
      assert.equal(request.buying_mode, 'wholesale');
      assert.equal(typeof request.brief, 'string');
      return { success: false, error: 'INVALID_REQUEST: brief is forbidden for wholesale discovery' };
    },
    async createMediaBuy() { mutations++; throw new Error('discovery failure must stop creation'); },
    async updateMediaBuy() { mutations++; throw new Error('discovery failure must stop updates'); },
  });
  runOptions.brand = { domain: 'acmeoutdoor.example' };
  const result = await runStoryboard('https://seller.example/mcp', storyboard, runOptions);
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1, JSON.stringify(result));
  assert.equal(result.skipped_count, 2, JSON.stringify(result));
  assert.equal(discovery.account.sandbox, true);
  assert.equal(mutations, 0);
});

test('SDK 9.6.2 constructs fixture-backed buyer bids and budget-only updates after validated discovery', async () => {
  const storyboard = auctionSteps();
  // This positive case starts after validated discovery. It does not qualify
  // SDK 9's wholesale builder, whose malformed request is covered above.
  storyboard.phases = storyboard.phases.filter(phase =>
    !phase.steps.some(step => step.id === 'get_products_brief'));
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
  storyboard.context = { ...storyboard.context, products: [
    // Unrelated inventory can precede both fixtures and have a higher floor.
    { product_id: 'unrelated-first', pricing_options: [{ pricing_model: 'cpm', floor_price: 1000 }] }, video, display,
  ] };
  const result = await runStoryboard('https://seller.example/mcp', storyboard, runOptions);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.passed_count, 2, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.deepEqual(updated.packages.map(pkg => pkg.budget), [12000, 13000]);
});
