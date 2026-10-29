const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { parseStoryboard, runStoryboard } = require('@adcp/sdk/testing');
const complianceRoot = process.env.ADCP_COMPLIANCE_TEST_ROOT || path.join(__dirname, '..', 'static', 'compliance', 'source');

function loadMediaBuyStoryboard(name) {
  return YAML.parse(fs.readFileSync(path.join(complianceRoot, 'protocols', 'media-buy', 'scenarios', `${name}.yaml`), 'utf8'));
}

for (const name of ['invalid_transitions', 'measurement_terms_rejected', 'creative_fate_after_cancellation', 'dependency_impairment', 'dependency_impairment_cardinality']) {
  for (const pricing of [{ fixed_price: 14 }, { floor_price: 8 }]) {
    test(`${name} prepares valid buys from ${'fixed_price' in pricing ? 'fixed' : 'auction'} CPM discovery`, async () => {
      const storyboard = loadMediaBuyStoryboard(name);
      // Exercise the source discovery and every create request, including reuse
      // and two-package setup. Lifecycle effects have their own coverage.
      const steps = storyboard.phases.flatMap(phase => phase.steps)
        .filter(step => ['get_products', 'list_creative_formats', 'create_media_buy'].includes(step.task))
        .map(step => ({ ...step, validations: step.validations.filter(v => v.check !== 'response_schema') }));
      const tools = ['get_products', 'list_creative_formats', 'create_media_buy', 'comply_test_controller'];
      const requests = [];
      const formatRequests = [];
      const result = await runStoryboard('https://seller.example/mcp', {
        ...storyboard, prerequisites: undefined, fixtures: undefined, requires: undefined,
        phases: [{ id: 'pricing_setup', title: 'Pricing setup', steps }],
      }, {
        _profile: { tools, raw_capabilities: {
          creative: { has_creative_library: true }, media_buy: { propagation_surfaces: ['snapshot'] },
        } },
        agentTools: tools,
        _client: {
          resetContext() {},
          async getProducts(request) {
            assert.equal(request.filters?.is_fixed_price, undefined, 'shared lifecycle checks accept either offer type');
            return { success: true, data: { products: [{
              product_id: 'seller-display',
              pricing_options: [{ pricing_option_id: 'seller-cpm', pricing_model: 'cpm', currency: 'USD', ...pricing }],
              format_ids: [{ agent_url: 'https://creative.example', id: 'display_300x250' }],
              format_options: [{ format_option_id: 'seller-image', format_kind: 'image', params: { width: 300, height: 250 } }],
            }], context: request.context } };
          },
          async listCreativeFormats(request) {
            formatRequests.push(request);
            const formatId = { agent_url: 'https://creative.example', id: 'display_300x250' };
            assert.deepEqual(request.format_ids, [formatId], 'legacy format lookup uses the discovered product reference');
            return { success: true, data: { formats: [{ format_id: formatId }], context: request.context } };
          },
          async createMediaBuy(request) {
            requests.push(request);
            for (const pkg of request.packages) {
              assert.equal(pkg.product_id, 'seller-display');
              assert.equal(pkg.pricing_option_id, 'seller-cpm');
              if ('floor_price' in pricing) assert.ok(pkg.bid_price >= pricing.floor_price, 'every auction package needs a valid bid');
              else assert.equal(pkg.bid_price, undefined, 'fixed-price packages do not bid');
            }
            if (name === 'measurement_terms_rejected') {
              assert.equal(request.packages[0].measurement_terms.billing_measurement.max_variance_percent, 0);
              return { success: false, data: { errors: [{ code: 'TERMS_REJECTED', message: 'Unsupported measurement terms' }], context: request.context } };
            }
            return { success: true, data: {
              media_buy_id: `seller-buy-${requests.length}`,
              packages: request.packages.map((pkg, i) => ({ ...pkg, package_id: `seller-package-${i}` })),
              context: request.context,
            } };
          },
        },
      });
      assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
      assert.equal(result.failed_count, 0);
      assert.equal(result.skipped_count, 0);
      assert.equal(requests.length, name === 'creative_fate_after_cancellation' ? 2 : 1);
      assert.equal(formatRequests.length, steps.filter(step => step.task === 'list_creative_formats').length);
      if (name === 'dependency_impairment_cardinality') assert.equal(requests[0].packages.length, 2);
    });
  }
}

for (const supportsForce of [false, true]) {
  test(`stale-cache probe warms auction inventory before forcing and gates unsupported forcing (${supportsForce})`, async () => {
    const storyboard = parseStoryboard(fs.readFileSync(path.join(complianceRoot, 'universal', 'stale-response-advisory.yaml'), 'utf8'));
    const phases = storyboard.phases.filter(p => p.id !== 'capability_discovery').map(p => ({
      ...p, steps: p.steps.map(s => ({ ...s, validations: s.validations.filter(v => v.check !== 'response_schema') })),
    }));
    const tools = ['get_products', 'comply_test_controller'];
    const calls = [];
    let forced = false;
    const result = await runStoryboard('https://seller.example/mcp', {
      ...storyboard, prerequisites: undefined, fixtures: undefined, requires: undefined, phases,
    }, {
      _profile: { tools, raw_capabilities: { compliance_testing: { scenarios: supportsForce ? ['force_upstream_unavailable'] : [] } } },
      agentTools: tools,
      _client: {
        resetContext() {},
        async getProducts(request) {
          calls.push({ task: 'get_products', request, forced });
          return { success: true, data: {
            products: [{ product_id: 'auction-display', pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', floor_price: 8 }] }],
            ...(forced ? { errors: [{ code: 'STALE_RESPONSE', details: { served_from_cache: true, cache_age_seconds: 60 } }] } : {}),
            context: request.context,
          } };
        },
        async executeTask(task, request) {
          assert.equal(task, 'comply_test_controller');
          assert.equal(request.scenario, 'force_upstream_unavailable');
          assert.equal(calls.length, 1, 'healthy cache-warming request precedes forced outage');
          assert.deepEqual(request.account, calls[0].request.account, 'outage forcing uses the same account as the warmed cache');
          forced = true;
          calls.push({ task, request });
          return { success: true, data: { success: true, context: request.context } };
        },
      },
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.equal(result.validations_advisory_failed ?? 0, 0);
    assert.equal(calls.length, supportsForce ? 3 : 1);
    assert.equal(calls[0].forced, false);
    const forcing = result.phases.find(phase => phase.phase_id === 'stale_response_forcing');
    assert.ok(forcing, 'forced-cache phase is represented in the report');
    if (!supportsForce) {
      for (const step of forcing.steps) {
        assert.equal(step.passed, true);
        assert.equal(step.skipped, true);
        assert.equal(step.skip_reason, 'not_applicable', 'unsupported forcing is a clean capability skip');
      }
    }
    if (supportsForce) {
      assert.equal(result.skipped_count, 0);
      assert.equal(calls[2].forced, true);
      assert.equal(calls[0].request.brief, calls[2].request.brief);
      assert.deepEqual(calls[0].request.account, calls[2].request.account);
    }
  });
}
