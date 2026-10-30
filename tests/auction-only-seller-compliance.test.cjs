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

const metricAndFormatScenarios = ['measurement_accountability', 'vendor_metric_accountability', 'canonical_formats'];

function productFixtures(storyboard) {
  if (!storyboard || typeof storyboard !== 'object') return [];
  return [
    ...(storyboard.fixtures?.products ?? []),
    ...(storyboard.phases ?? []).flatMap(phase => phase.steps ?? [])
      .filter(step => step.task === 'comply_test_controller' && step.sample_request?.scenario === 'seed_product')
      .map(step => ({ product_id: step.sample_request.params.product_id, ...step.sample_request.params.fixture })),
  ];
}

function pricingFixtures(storyboard) {
  return [
    ...(storyboard.fixtures?.pricing_options ?? []),
    ...productFixtures(storyboard).flatMap(product => (product.pricing_options ?? []).map(price => ({ product_id: product.product_id, ...price }))),
    ...storyboard.phases.flatMap(phase => phase.steps)
      .filter(step => step.task === 'comply_test_controller' && step.sample_request?.scenario === 'seed_pricing_option')
      .map(step => ({ ...step.sample_request.params.fixture, product_id: step.sample_request.params.product_id, pricing_option_id: step.sample_request.params.pricing_option_id })),
  ];
}

test('compliance product fixtures use schema channel values', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'static', 'schemas', 'source', 'enums', 'channels.json'), 'utf8'));
  const directory = complianceRoot;
  function inspect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith('.yaml')) {
        const storyboard = YAML.parse(fs.readFileSync(file, 'utf8'));
        for (const product of productFixtures(storyboard)) {
          for (const channel of product.channels ?? []) {
            assert.ok(schema.enum.includes(channel), `${storyboard.id}/${product.product_id} uses invalid channel ${channel}`);
          }
        }
      }
    }
  }
  inspect(directory);
});

for (const name of [...metricAndFormatScenarios, 'pricing_currency_filter']) {
  test(`${name} seeds auction CPM without requiring fixed-rate support`, () => {
    const storyboard = loadMediaBuyStoryboard(name);
    const prices = pricingFixtures(storyboard);
    assert.ok(prices.length > 0);
    for (const price of prices) {
      assert.equal(price.pricing_model, 'cpm');
      assert.equal(price.fixed_price, undefined);
      assert.ok(price.floor_price > 0);
    }
  });
}

for (const name of metricAndFormatScenarios) {
  for (const pricing of [{ fixed_price: 14 }, { floor_price: 8 }]) {
    test(`${name} discovers and buys ${'fixed_price' in pricing ? 'fixed' : 'auction'} CPM inventory`, async () => {
      const storyboard = loadMediaBuyStoryboard(name);
      const sourceSteps = storyboard.phases.flatMap(phase => phase.steps);
      const discovery = sourceSteps.find(step => step.task === 'get_products');
      const creates = sourceSteps.filter(step => step.task === 'create_media_buy' && !step.id.startsWith('reject_'));
      // Exercise real request construction and discovery assertions. Format
      // satisfaction and reporting commitments have their own contract suites.
      const steps = [discovery, ...creates].map(step => ({
        ...step,
        // Pagination and physical response schemas are exercised by the full
        // canonical slices; these minimal fakes isolate pricing construction.
        collect_product_pages: undefined,
        validations: step.validations.filter(v => step.task === 'get_products'
          ? ['field_present', 'field_value', 'field_absent', 'field_contains'].includes(v.check)
          : v.check === 'field_present' && v.path === 'media_buy_id'),
      }));
      const fixture = productFixtures(storyboard).find(product => product.delivery_type);
      const fixturePrice = pricingFixtures(storyboard).find(price => price.product_id === fixture.product_id);
      const priceFields = { ...fixturePrice };
      delete priceFields.product_id;
      delete priceFields.fixed_price;
      delete priceFields.floor_price;
      const product = { ...fixture, pricing_options: [{ ...priceFields, ...pricing }] };
      const tools = ['get_products', 'create_media_buy', 'comply_test_controller'];
      const buys = [];
      const result = await runStoryboard('https://seller.example/mcp', {
        ...storyboard, prerequisites: undefined, fixtures: undefined, fixture_resolution: undefined, requires: undefined,
        phases: [{ id: 'pricing_setup', title: 'Pricing setup', steps }],
      }, {
        _profile: { tools, raw_capabilities: {
          media_buy: { buying_modes: ['wholesale'], features: { committed_metrics_supported: true } },
          compliance_testing: { scenarios: ['seed_product', 'seed_pricing_option'] },
        } },
        agentTools: tools,
        _client: {
          resetContext() {},
          async executeTask(task, request) {
            if (task === 'get_products') return this.getProducts(request);
            assert.equal(task, 'create_media_buy');
            return this.createMediaBuy(request);
          },
          async getProducts(request) {
            // An auction-only seller truthfully returns no fixed-price matches.
            const matches = request.filters?.is_fixed_price !== true || 'fixed_price' in pricing;
            return { success: true, data: { products: matches ? [product] : [], context: request.context } };
          },
          async createMediaBuy(request) {
            buys.push(request);
            for (const pkg of request.packages) {
              assert.equal(pkg.product_id, product.product_id);
              assert.equal(pkg.pricing_option_id, priceFields.pricing_option_id);
              if ('floor_price' in pricing) assert.ok(pkg.bid_price >= pricing.floor_price);
              else assert.equal(pkg.bid_price, undefined);
            }
            return { success: true, data: {
              media_buy_id: `buy-${buys.length}`,
              confirmed_at: '2099-05-01T00:00:00Z',
              packages: request.packages.map((pkg, i) => ({
                ...pkg,
                package_id: `pkg-${i}`,
                ...(pkg.committed_metrics ? { committed_metrics: pkg.committed_metrics.map(metric => ({
                  ...metric, committed_at: '2099-05-01T00:00:00Z',
                })) } : {}),
              })),
              context: request.context,
            } };
          },
        },
      });
      assert.equal(result.overall_passed, true, JSON.stringify(result.phases.flatMap(phase => phase.steps)
        .filter(step => !step.passed).map(step => ({ id: step.step_id, error: step.error, validations: step.validations.filter(v => !v.passed) }))));
      assert.equal(result.failed_count, 0);
      assert.equal(result.skipped_count, 0);
      assert.equal(buys.length, creates.length);
      assert.ok(buys.length > 0);
    });
  }
}

for (const defect of [null, 'wrong_product', 'split_format', 'broken_projection', 'split_advisory']) {
  test(`canonical discovery binds each format contract to the same product (${defect ?? 'reordered catalog'})`, async () => {
    const storyboard = loadMediaBuyStoryboard('canonical_formats');
    const products = structuredClone(productFixtures(storyboard).filter(product => product.delivery_type)).reverse();
    const target = products.find(product => product.product_id === 'canonical_formats_mrec_display');
    const errors = [{ code: 'UNRELATED_ADVISORY', source: 'producer' }, { code: 'FORMAT_DECLARATION_DIVERGENT', source: 'producer' }];
    if (defect === 'wrong_product') {
      const decoy = structuredClone(target);
      decoy.product_id = 'unrelated-product';
      products.unshift(decoy);
      target.format_options[0].params.width = 728;
    }
    if (defect === 'split_format') {
      const decoy = structuredClone(target.format_options[0]);
      decoy.format_option_id = 'different-format-option';
      target.format_options[0].params.width = 728;
      target.format_options.push(decoy);
    }
    if (defect === 'broken_projection') target.format_options[0].v1_format_ref[0].id = 'wrong-projection';
    if (defect === 'split_advisory') errors[1].source = 'intermediary';
    const steps = storyboard.phases.flatMap(phase => phase.steps).filter(step => step.task === 'get_products').map(step => ({
      ...step, auth: undefined, collect_product_pages: undefined,
      validations: step.validations.filter(validation => validation.check !== 'response_schema'),
    }));
    const tools = ['get_products', 'comply_test_controller'];
    const result = await runStoryboard('https://seller.example/mcp', {
      ...storyboard, prerequisites: undefined, fixtures: undefined, fixture_resolution: undefined,
      requires: undefined, phases: [{ id: 'discovery', title: 'Discovery', steps }],
    }, {
      agentTools: tools,
      _profile: { tools, raw_capabilities: {
        media_buy: { buying_modes: ['wholesale'] }, compliance_testing: { scenarios: ['seed_product'] },
      } },
      _client: {
        resetContext() {},
        async executeTask(task, request) {
          assert.equal(task, 'get_products');
          assert.equal(request.filters?.required_vendor_metrics, undefined, 'format discovery requires no reporting vendor');
          return { success: true, data: { products, errors, context: request.context } };
        },
      },
    });
    const failures = result.phases.flatMap(phase => phase.steps).flatMap(step => step.validations).filter(validation => !validation.passed);
    assert.equal(result.overall_passed, defect === null, JSON.stringify(failures));
    if (defect === null) assert.equal(result.skipped_count, 0, 'every seeded migration shape is checked');
    else assert.ok(failures.some(validation => validation.check === 'field_contains'), 'partial contracts cannot be assembled from unrelated records');
  });
}

for (const name of ['invalid_transitions', 'measurement_terms_rejected', 'measurement_terms_accepted', 'pending_creatives_to_start', 'inventory_list_targeting', 'inventory_list_no_match', 'creative_fate_after_cancellation', 'dependency_impairment', 'dependency_impairment_cardinality']) {
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
          creative: { has_creative_library: true }, media_buy: {
            propagation_surfaces: ['snapshot'], creative_approval_mode: 'auto_approve',
            measurement_terms_acceptance: true, execution: { targeting: { property_list: true } },
          },
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
              measurement_terms: { billing_measurement: { max_variance_percent: 5 } },
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
            if (['measurement_terms_rejected', 'inventory_list_no_match'].includes(name)) {
              if (name === 'measurement_terms_rejected') assert.equal(request.packages[0].measurement_terms.billing_measurement.max_variance_percent, 0);
              return { success: false, data: { errors: [{
                code: name === 'measurement_terms_rejected' ? 'TERMS_REJECTED' : 'PRODUCT_UNAVAILABLE',
                message: 'Unsupported measurement terms or inventory list',
              }], context: request.context } };
            }
            return { success: true, data: {
              media_buy_id: `seller-buy-${requests.length}`,
              status: 'completed', media_buy_status: 'pending_creatives',
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


test('inline creative discovery accepts either pricing structure while retaining format gates', () => {
  const storyboard = loadMediaBuyStoryboard('inline_creatives_without_sync');
  const reads = storyboard.phases.flatMap(phase => phase.steps).filter(step => step.task === 'get_products');
  assert.equal(reads.length, 2);
  for (const step of reads) {
    assert.equal(step.sample_request.filters?.is_fixed_price, undefined);
    assert.ok(step.context_outputs.some(output => output.path === 'products[0].pricing_options[0].pricing_option_id'));
    assert.ok(step.validations.some(validation => validation.check === 'field_present'
      && validation.path === 'products[0].pricing_options[0].pricing_option_id'));
    assert.ok(!step.validations.some(validation => validation.path?.endsWith('.fixed_price')));
  }
  const canonical = reads.find(step => step.context_outputs.some(output => output.key === 'canonical_product_id'));
  assert.ok(canonical.validations.some(validation => validation.path?.startsWith('products[0].format_options[0]')));
  const legacy = reads.find(step => step.context_outputs.some(output => output.key === 'legacy_product_id'));
  assert.ok(legacy.validations.some(validation => validation.path === 'products[0].format_ids[0].id'));
});
