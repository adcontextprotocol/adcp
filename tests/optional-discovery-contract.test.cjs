'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const { parseStoryboard, runStoryboard } = require('@adcp/sdk/testing');

const root = path.join(__dirname, '..');
const load = relative => parseStoryboard(fs.readFileSync(path.join(root, 'static/compliance/source', relative), 'utf8'));
const provenance = ['provenance_enforcement', 'provenance_truth_of_claim', 'provenance_audit_observation'];
const tools = ['get_adcp_capabilities', 'get_products', 'sync_creatives', 'comply_test_controller'];

async function runProvenanceDiscovery(name, products) {
  const storyboard = load(`protocols/media-buy/scenarios/${name}.yaml`);
  storyboard.prerequisites = undefined;
  storyboard.fixtures = undefined;
  storyboard.phases = [storyboard.phases[0]];
  for (const step of storyboard.phases[0].steps) step.validations = step.validations.filter(v => v.check !== 'response_schema');
  return runStoryboard('https://seller.example/mcp', storyboard, {
    agentTools: tools,
    _profile: { tools, raw_capabilities: {
      creative: { has_creative_library: true, supports_provenance: true },
      ...(name === 'provenance_audit_observation' && {
        compliance_testing: { scenarios: ['query_provenance_audit_observations'] },
      }),
    } },
    _client: { resetContext() {}, async getProducts(request) {
      return { success: true, data: { products, context: request.context } };
    } },
  });
}

for (const name of provenance) {
  for (const supported of [undefined, false]) {
    test(`${name} skips before seeding when provenance support is ${supported}`, async () => {
      const storyboard = load(`protocols/media-buy/scenarios/${name}.yaml`);
      const result = await runStoryboard('https://seller.example/mcp', storyboard, {
        agentTools: tools,
        _profile: { tools, raw_capabilities: {
          creative: {
            has_creative_library: true,
            ...(supported !== undefined && { supports_provenance: supported }),
          },
          ...(name === 'provenance_audit_observation' && {
            compliance_testing: { scenarios: ['query_provenance_audit_observations'] },
          }),
        } },
        _client: { resetContext() {}, async executeTask() { assert.fail('Unsupported provenance must not seed or dispatch'); } },
      });
      assert.equal(result.failed_count, 0);
      assert.equal(result.skipped_count, 1);
      assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
    });
  }

  for (const publishesPolicy of [false, true]) {
    test(`${name}: an opted-in seller ${publishesPolicy ? 'passes' : 'fails'} discovery ${publishesPolicy ? 'with' : 'without'} its declared policy`, async () => {
      const storyboard = load(`protocols/media-buy/scenarios/${name}.yaml`);
      const product = structuredClone(storyboard.fixtures.products[0]);
      if (!publishesPolicy) delete product.creative_policy;
      const result = await runProvenanceDiscovery(name, [product]);
      assert.equal(result.overall_passed, publishesPolicy, JSON.stringify(result.phases));
      assert.equal(result.skipped_count, 0);
    });
  }

  test(`${name} discovers the seeded policy independently of product ordering`, async () => {
    const storyboard = load(`protocols/media-buy/scenarios/${name}.yaml`);
    const product = structuredClone(storyboard.fixtures.products[0]);
    const unrelated = { ...structuredClone(product), product_id: 'unrelated-product' };
    delete unrelated.creative_policy;
    for (const products of [[unrelated, product], [product, unrelated]]) {
      const result = await runProvenanceDiscovery(name, products);
      assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
      assert.equal(result.skipped_count, 0);
    }
  });

  for (const defect of ['wrong_product', 'split_policy']) {
    test(`${name} rejects provenance policy supplied by a different product (${defect})`, async () => {
      const storyboard = load(`protocols/media-buy/scenarios/${name}.yaml`);
      const product = structuredClone(storyboard.fixtures.products[0]);
      const other = { ...structuredClone(product), product_id: 'other-policy-product' };
      if (defect === 'wrong_product') delete product.creative_policy;
      else if (name === 'provenance_enforcement') {
        delete product.creative_policy.provenance_requirements.require_disclosure_metadata;
        delete other.creative_policy.provenance_required;
        delete other.creative_policy.accepted_verifiers;
      } else {
        product.creative_policy.accepted_verifiers = [{ agent_url: 'https://other-verifier.example/mcp' }];
      }
      const result = await runProvenanceDiscovery(name, [product, other]);
      assert.equal(result.overall_passed, false, JSON.stringify(result.phases));
      assert.equal(result.skipped_count, 0);
      assert.ok(result.phases[0].steps[0].validations.some(v => v.check === 'field_contains' && !v.passed));
    });
  }
}

test('provenance audit observations require the separately advertised sandbox query hook', async () => {
  const storyboard = load('protocols/media-buy/scenarios/provenance_audit_observation.yaml');
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    agentTools: tools,
    _profile: { tools, raw_capabilities: {
      creative: { has_creative_library: true, supports_provenance: true },
      compliance_testing: { scenarios: ['seed_account', 'seed_product', 'seed_pricing_option'] },
    } },
    _client: { resetContext() {}, async executeTask() { assert.fail('An unavailable audit hook must gate before fixture mutation'); } },
  });
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);
  const skipped = result.phases[0].steps[0];
  assert.equal(skipped.skip_reason, 'capability_unsupported');
  assert.match(skipped.error, /compliance_testing\.scenarios/);
});

test('provenance audit discovery, sync, and observation queries use the same seeded account', () => {
  const storyboard = load('protocols/media-buy/scenarios/provenance_audit_observation.yaml');
  const fixture = storyboard.fixtures.accounts.find(entry => entry.fixture.sandbox === true).fixture;
  const expected = {
    brand: fixture.brand,
    operator: fixture.operator,
    operator_unit: fixture.operator_unit,
    sandbox: fixture.sandbox,
  };
  const steps = storyboard.phases.flatMap(phase => phase.steps).filter(step =>
    ['get_products', 'sync_creatives'].includes(step.task)
    || step.sample_request?.scenario === 'query_provenance_audit_observations');
  assert.equal(steps.filter(step => step.sample_request?.scenario === 'query_provenance_audit_observations').length, 2);
  for (const step of steps) assert.deepEqual(step.sample_request.account, expected, step.id);
});

test('provenance opt-in is an optional boolean, distinct from a creative library', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'static/schemas/source/protocol/get-adcp-capabilities-completed.json'), 'utf8'));
  const creative = schema.properties.creative;
  assert.ok(!creative.required?.includes('supports_provenance'));
  assert.equal(creative.properties.supports_provenance.default, false);
  const validate = new Ajv({ strict: false }).compile(creative.properties.supports_provenance);
  for (const valid of [true, false]) assert.equal(validate(valid), true);
  for (const invalid of ['true', null, 1]) assert.equal(validate(invalid), false);
  const releasedProduct = JSON.parse(fs.readFileSync(path.join(root, 'dist/schemas/3.1.0/core/product.json'), 'utf8'));
  assert.ok(releasedProduct.properties.creative_policy, 'creative_policy already exists in 3.1');
  assert.ok(!releasedProduct.required.includes('creative_policy'), 'publishing creative_policy is optional');
});

for (const hasFloor of [true, false]) {
  test(`auction request construction and budget update work without price guidance (${hasFloor ? 'declared' : 'absent'} floors)`, async () => {
    const storyboard = load('specialisms/sales-non-guaranteed/index.yaml');
    const products = storyboard.fixtures.products.map(product => ({
      ...product,
      pricing_options: storyboard.fixtures.pricing_options.filter(price => price.product_id === product.product_id).map(price => {
        const option = { ...price };
        delete option.product_id;
        delete option.price_guidance;
        if (hasFloor) option.floor_price *= 10;
        else delete option.floor_price;
        return option;
      }),
    }));
    // Isolate post-discovery request construction. The catalog-adaptive
    // fixture/preflight contract still selects floor-bearing pricing options.
    storyboard.prerequisites = undefined;
    storyboard.fixtures = undefined;
    storyboard.fixture_resolution = undefined;
    storyboard.phases = storyboard.phases.filter(phase => ['product_discovery', 'create_buy', 'adjust_bids'].includes(phase.id));
    assert.equal(storyboard.phases.length, 3);
    for (const phase of storyboard.phases) for (const step of phase.steps) {
      step.validations = step.validations.filter(v => !['response_schema', 'upstream_traffic'].includes(v.check));
    }
    let packages;
    let created = false;
    let updated = false;
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      agentTools: [...tools, 'create_media_buy', 'update_media_buy'],
      _profile: { tools: [...tools, 'create_media_buy', 'update_media_buy'] },
      _client: {
        resetContext() {},
        async getProducts(request) { return { success: true, data: { products, context: request.context } }; },
        async createMediaBuy(request) {
          created = true;
          packages = request.packages.map((pkg, i) => {
            assert.ok(Number.isFinite(pkg.bid_price) && pkg.bid_price > 0);
            if (hasFloor) assert.ok(pkg.bid_price >= products[i].pricing_options[0].floor_price);
            return { ...pkg, package_id: `package-${i}` };
          });
          return { success: true, data: { media_buy_id: 'buy', media_buy_status: 'active', packages, context: request.context } };
        },
        async updateMediaBuy(request) {
          updated = true;
          const affected_packages = request.packages.map((pkg, i) => {
            assert.equal(pkg.bid_price, undefined, 'Budget-only updates preserve the accepted bid');
            return { ...packages[i], ...pkg };
          });
          return { success: true, data: { affected_packages, context: request.context } };
        },
      },
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.equal(result.skipped_count, 0);
    assert.ok(created && updated);
  });
}
