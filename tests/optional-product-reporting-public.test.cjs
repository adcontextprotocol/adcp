'use strict';

// Reproducible security qualification for the ACTUAL reporting storyboards.
// Uses only the SDK's public runner/profile/transport APIs. All MCP I/O is
// intercepted by trustedFetchFn; no private client seams or network writes.
// Run: node --test --test-timeout=30000 tests/optional-product-reporting-public.test.cjs
// These probes do not resolve the disclosed commercial/standalone merge holds.
// The caller explicitly configures public options.brand to the declared sandbox
// brand. SDK 15.9.5 otherwise substitutes test.example on create_media_buy even
// when sample_request.brand names a different brand. That unconfigured caller
// limitation is not repaired by these source-only security checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');

const SOURCE = path.join(__dirname, '../static/compliance/source/protocols/media-buy/scenarios');
const FILES = { format: 'advanced_delivery_reporting.yaml', time: 'time_based_delivery_reporting.yaml' };
const ENDPOINT = 'https://reporting-security-probe.example/mcp';
const TOOLS = ['get_adcp_capabilities', 'get_products', 'create_media_buy', 'get_media_buy_delivery', 'comply_test_controller'];
const SCENARIOS = ['seed_account', 'simulate_delivery'];
const CAPS = {
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
  media_buy: { buying_modes: ['brief', 'wholesale'] },
  compliance_testing: { scenarios: SCENARIOS },
};

function product(kind) {
  return {
    product_id: `native-${kind}-offer`, name: 'Native sandbox offer', description: 'Seller-owned sandbox catalog offer.',
    publisher_properties: [{ publisher_domain: 'seller.example', selection_type: 'all' }],
    channels: ['olv'], delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'image', format_kind: 'image', params: { width: 300, height: 250 } }],
    pricing_options: [{ pricing_option_id: `native-${kind}-cpm`, pricing_model: 'cpm', currency: 'EUR', fixed_price: 17 }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'], expected_delay_minutes: 0, timezone: 'UTC', supports_webhooks: false,
      available_metrics: ['impressions', 'spend', 'clicks', ...(kind === 'time' ? ['time_based_views'] : [])],
      date_range_support: 'date_range', ...(kind === 'format' ? { supports_format_breakdown: true } : {}),
    },
  };
}

async function execute(kind, { adversarialAccount = false, broken, configureBrand = true } = {}) {
  const doc = loadStoryboardFile(path.join(SOURCE, FILES[kind]));
  const expectedAccount = structuredClone(doc.context.sandbox_account);
  const offer = product(kind);
  const calls = [];
  const methods = [];

  const trustedFetchFn = async (input, init = {}) => {
    assert.equal(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin, new URL(ENDPOINT).origin);
    const message = JSON.parse(init.body);
    methods.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'reporting-security-probe', version: '1' } };
    } else if (message.method.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = { tools: TOOLS.map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } })) };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ task: name, request: structuredClone(request) });
      let data;
      if (name === 'get_adcp_capabilities') {
        data = CAPS;
      } else if (name === 'comply_test_controller') {
        assert.equal(request.account.sandbox, true, 'controller calls remain sandbox-scoped');
        assert.ok(['list_scenarios', ...SCENARIOS].includes(request.scenario), 'no product/pricing feature seeding is permitted');
        if (request.scenario === 'list_scenarios') {
          data = { success: true, scenarios: SCENARIOS };
        } else if (request.scenario === 'seed_account') {
          for (const key of ['brand', 'operator', 'operator_unit', 'sandbox']) {
            assert.deepEqual(request.params.fixture[key], expectedAccount[key], `account fixture preserves ${key}`);
          }
          data = { success: true, ...(adversarialAccount ? {
            account: { brand: { domain: 'foreign.example' }, operator: 'foreign.example', sandbox: false },
          } : {}) };
        } else {
          assert.deepEqual(request.account, expectedAccount);
          assert.equal(request.params.media_buy_id, 'seller-buy');
          data = { success: true };
        }
      } else if (name === 'get_products') {
        assert.equal(request.buying_mode, 'wholesale');
        assert.deepEqual(request.account, expectedAccount, 'discovery uses the same sandbox account as purchase');
        data = { status: 'completed', products: [offer], cache_scope: 'account', wholesale_feed_version: 'v1' };
      } else if (name === 'create_media_buy') {
        assert.deepEqual(request.account, expectedAccount, 'untrusted controller data cannot downgrade the purchase account');
        if (!configureBrand && request.brand?.domain !== doc.context.sandbox_brand.domain) {
          // A real seller may correctly reject a brand/account mismatch. Keep
          // the SDK's authored-brand override visible as a qualification hold.
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
            isError: true, content: [{ type: 'text', text: 'Brand does not match the qualified sandbox account' }],
          } }), { headers: { 'content-type': 'application/json' } });
        }
        assert.deepEqual(request.brand, doc.context.sandbox_brand);
        assert.equal(request.packages[0].product_id, offer.product_id);
        assert.equal(request.packages[0].pricing_option_id, offer.pricing_options[0].pricing_option_id);
        data = {
          status: 'completed', media_buy_id: 'seller-buy', confirmed_at: '2026-10-19T00:00:00Z', revision: 1,
          packages: [{ package_id: 'seller-package', product_id: offer.product_id, pricing_option_id: offer.pricing_options[0].pricing_option_id }],
        };
      } else if (name === 'get_media_buy_delivery') {
        assert.deepEqual(request.account, expectedAccount, 'untrusted controller data cannot downgrade the reporting account');
        assert.deepEqual(request.media_buy_ids, ['seller-buy']);
        const totals = { impressions: 1001, spend: 0 };
        const pkg = { package_id: 'seller-package', impressions: 1001, spend: 0, pricing_model: 'cpm', rate: 17, currency: 'EUR' };
        if (kind === 'format') {
          Object.assign(pkg, { by_format: [], by_format_truncated: false, by_format_sorted_by: 'spend', by_format_sort_direction: 'asc' });
        } else {
          totals.time_based_views = [{ threshold_seconds: 3, basis: 'in_view', views: 400 }];
          pkg.time_based_views = structuredClone(totals.time_based_views);
        }
        const deliveries = [{ media_buy_id: broken === 'buy' ? 'unrequested-buy' : 'seller-buy', status: 'active', totals, by_package: [pkg] }];
        if (broken === 'extra_buy') deliveries.push({ ...structuredClone(deliveries[0]), media_buy_id: 'unrequested-buy' });
        data = {
          status: 'completed', reporting_period: { start: '2026-10-19T00:00:00Z', end: '2026-10-20T00:00:00Z' },
          media_buy_deliveries: deliveries,
        };
      } else {
        assert.fail(`Unexpected tool ${name}`);
      }
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else {
      assert.fail(`Unexpected JSON-RPC method ${message.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
  };

  const result = await runStoryboard(ENDPOINT, doc, {
    adcpVersion: '3.2.5', timeout_ms: 3000,
    ...(configureBrand && { brand: structuredClone(doc.context.sandbox_brand) }),
    profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
    transport: { trustedFetchFn },
  });
  assert.ok(methods.includes('initialize') && methods.includes('tools/call'), 'the real public MCP transport executes');
  assert.equal(calls.some(call => call.task === 'sync_accounts'), false, 'seeded sandbox setup needs no mutable account-sync extraction');
  assert.deepEqual(calls.filter(call => call.task === 'comply_test_controller' && call.request.scenario !== 'list_scenarios').map(call => call.request.scenario), configureBrand ? SCENARIOS : ['seed_account'], JSON.stringify(result));
  return { result, calls };
}

for (const kind of ['format', 'time']) {
  test(`${kind}: qualification counterexample preserves the public caller's default-brand mismatch`, async () => {
    const { result, calls } = await execute(kind, { configureBrand: false });
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    assert.equal(calls.find(call => call.task === 'create_media_buy').request.brand.domain, 'test.example');
    assert.ok(result.phases.flatMap(phase => phase.steps).some(step => step.step_id === 'create_buy' && !step.passed && !step.skipped));
  });

  test(`${kind}: public full runner preserves sandbox identity with normal and adversarial controller responses`, async () => {
    for (const adversarialAccount of [false, true]) {
      const { result, calls } = await execute(kind, { adversarialAccount });
      assert.equal(result.overall_passed, true, JSON.stringify(result));
      assert.equal(result.fixture_resolutions.every(record => record.status === 'resolved' && record.strategy === 'discover'), true);
      assert.equal(calls.filter(call => call.task === 'create_media_buy').length, 1);
      assert.equal(calls.filter(call => call.task === 'get_media_buy_delivery').length, 1);
    }
  });

  test(`${kind}: public full runner rejects wrong and extra buy rows and preserves raw failure evidence`, async () => {
    for (const broken of ['buy', 'extra_buy']) {
      const { result } = await execute(kind, { broken });
      assert.equal(result.overall_passed, false, JSON.stringify(result));
      const report = result.phases.flatMap(phase => phase.steps).find(step => step.task === 'get_media_buy_delivery');
      assert.ok(report && !report.passed && !report.skipped, JSON.stringify(result));
      assert.ok(report.response.media_buy_deliveries.some(row => row.media_buy_id === 'unrequested-buy'), 'raw unrequested rows remain available for diagnosis');
      assert.equal(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false, false);
    }
  });
}
