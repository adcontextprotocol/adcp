'use strict';

// Reproducible security qualification for the ACTUAL reporting storyboards.
// Uses only the SDK's public runner/profile/transport APIs. All MCP I/O is
// intercepted by trustedFetchFn; no private client seams or network writes.
// Run: node --test --test-timeout=30000 tests/optional-product-reporting-public.test.cjs
// Executes production caller preparation for actual full and standalone source.
// Both configured and option-omitting repository callers use authored sandbox identity;
// a bare SDK control retains the separately disclosed upstream default (issue3381).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadStoryboardFile, runStoryboard: runRawStoryboard } = require('@adcp/sdk/testing');
const { runCatalogReportingStoryboard: runStoryboard, runCatalogReportingStoryboardStep: runStoryboardStep } = require('../server/src/compliance/catalog-reporting-runner.ts');

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

async function execute(kind, { adversarialAccount = false, broken, configureBrand = true, rawCaller = false, minSpend, standalone = false, decoy = false, hostDenied = false, suppliedState = false, callerContext, runOverrides = {}, localRejection = false, discoveryFailure = false } = {}) {
  const doc = loadStoryboardFile(path.join(SOURCE, FILES[kind]));
  const expectedAccount = structuredClone(doc.context.sandbox_account);
  const offer = product(kind);
  if (minSpend !== undefined) offer.pricing_options[0].min_spend_per_package = minSpend;
  const selectedPrice = structuredClone(offer.pricing_options[0]);
  if (decoy) offer.pricing_options.unshift({ pricing_option_id: 'a-auction-decoy', pricing_model: 'cpm', currency: 'USD', floor_price: 999 });
  const audits = [];
  const lookups = [];
  const calls = [];
  const methods = [];
  const allHttp = [];

  const trustedFetchFn = async (input, init = {}) => {
    allHttp.push({ url: typeof input === 'string' || input instanceof URL ? String(input) : input.url, method: init.method ?? 'GET' });
    assert.equal(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin, new URL(ENDPOINT).origin);
    if (!init.body) return new Response(null, { status: init.method === 'DELETE' ? 202 : 405 });
    const message = JSON.parse(init.body);
    methods.push(message.method);
    let result;
    if (message.method === 'server/discover') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'No discovery extension' } }), { headers: { 'content-type': 'application/json' } });
    } else if (message.method === 'initialize') {
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
        data = { status: 'completed', products: discoveryFailure ? [{ product_id: 'malformed-private-fixture' }] : [offer], cache_scope: 'account', wholesale_feed_version: 'v1' };
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
        assert.equal(request.packages[0].pricing_option_id, selectedPrice.pricing_option_id);
        assert.equal(request.packages[0].budget, Math.max(1000, minSpend ?? 0));
        assert.equal(request.packages[0].bid_price, undefined);
        assert.equal(request.currency, selectedPrice.currency);
        data = {
          status: 'completed', media_buy_id: 'seller-buy', confirmed_at: '2026-10-19T00:00:00Z', revision: 1,
          packages: [{ package_id: 'seller-package', product_id: offer.product_id, pricing_option_id: selectedPrice.pricing_option_id }],
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

  const options = {
    adcpVersion: '3.2.5', timeout_ms: 3000,
    ...(configureBrand && { brand: structuredClone(doc.context.sandbox_brand) }),
    profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
    transport: { trustedFetchFn },
    ...(rawCaller && { context: { catalog_reporting_budget: 1000 } }),
    ...(decoy && { context: { products: [{ ...offer, pricing_options: [{ pricing_option_id: 'unrelated', pricing_model: 'cpm', currency: 'USD', floor_price: 999 }] }], catalog_reporting_budget: 1 } }),
    ...(hostDenied && { prepared_fixtures_authorizer: lookup => { lookups.push(lookup); return { authorized: false, detail: 'Trusted host refused this reuse' }; }, prepared_fixtures_audit_sink: record => { audits.push(record); } }),
    ...(callerContext && { context: callerContext }),
    ...runOverrides,
    ...(suppliedState && { prepared_fixtures: { ref: 'caller-supplied-ref', resolve: () => undefined } }),
  };
  let result;
  try {
    result = rawCaller ? await runRawStoryboard(ENDPOINT, doc, options) : standalone ? await runStoryboardStep(ENDPOINT, doc, 'create_buy', options) : await runStoryboard(ENDPOINT, doc, options);
  } catch (error) {
    if (!hostDenied && !suppliedState && !localRejection) throw error;
    return { error, calls, audits, lookups, methods, allHttp };
  }
  assert.ok(methods.includes('initialize') && methods.includes('tools/call'), 'the real public MCP transport executes');
  assert.equal(calls.some(call => call.task === 'sync_accounts'), false, 'seeded sandbox setup needs no mutable account-sync extraction');
  assert.deepEqual(calls.filter(call => call.task === 'comply_test_controller' && call.request.scenario !== 'list_scenarios').map(call => call.request.scenario), (!rawCaller || configureBrand) && !standalone ? SCENARIOS : ['seed_account'], JSON.stringify(result));
  return { result, calls };
}

for (const kind of ['format', 'time']) {
  test(`${kind}: qualification counterexample preserves the public caller's default-brand mismatch`, async () => {
    const { result, calls } = await execute(kind, { configureBrand: false, rawCaller: true });
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

for (const kind of ['format', 'time']) for (const minSpend of [undefined, 0, 5000]) {
  test(`${kind}: whole selected price preserves minimum ${String(minSpend)} for full and standalone`, async () => {
    for (const standalone of [false, true]) {
      const { result, calls } = await execute(kind, { minSpend, standalone });
      assert.equal(standalone ? result.passed : result.overall_passed, true, JSON.stringify(result));
      const buy = calls.find(call => call.task === 'create_media_buy');
      assert.equal(buy.request.packages[0].budget, Math.max(1000, minSpend ?? 0));
    }
  });
}

for (const kind of ['format', 'time']) {
  test(`${kind}: unrelated first pricing data cannot replace selected commercial terms`, async () => {
    for (const standalone of [false, true]) {
      const { result, calls } = await execute(kind, { minSpend: 5000, decoy: true, standalone });
      assert.equal(standalone ? result.passed : result.overall_passed, true, JSON.stringify(result));
      const buy = calls.find(call => call.task === 'create_media_buy').request;
      assert.equal(buy.currency, 'EUR');
      assert.equal(buy.packages[0].pricing_option_id, `native-${kind}-cpm`);
      assert.equal(buy.packages[0].budget, 5000);
      assert.equal(buy.packages[0].bid_price, undefined);
    }
  });
  test(`${kind}: host denial returns typed access error and retains complete private audit evidence`, async () => {
    for (const standalone of [false, true]) {
      const { error, calls, audits, lookups } = await execute(kind, { hostDenied: true, standalone });
      assert.equal(error.name, 'PreparedFixturesDeniedError');
      assert.ok(lookups.length > 0);
      assert.equal(calls.some(call => call.task === 'create_media_buy'), false);
      assert.equal(audits.length, 1);
      assert.ok(audits[0].fixture_resolutions.some(record => JSON.stringify(record.seller_ids).includes(`native-${kind}-offer`)));
      const steps = standalone ? [audits[0]] : audits[0].phases.flatMap(phase => phase.steps);
      assert.ok(steps.some(step => step.validations.some(validation => validation.check === 'prepared_fixtures_authorization' && validation.passed === false)));
      // A standalone audit is a complete step record, not a run-result envelope.
      assert.equal(JSON.stringify(error).includes(`native-${kind}-offer`), false);
    }
  });
  test(`${kind}: adapter rejects supplied reuse state before any seller contact`, async () => {
    const { error, methods } = await execute(kind, { suppliedState: true });
    assert.match(error.message, /must be owned by this invocation/);
    assert.deepEqual(methods, []);
  });
  test(`${kind}: failed preparation evidence stays private when host denies full and standalone reuse`, async () => {
    for (const standalone of [false, true]) {
      const { error, calls, audits, lookups, result } = await execute(kind, { hostDenied: true, discoveryFailure: true, standalone });
      assert.equal(result, undefined, 'denial must not return an enriched caller result');
      assert.equal(error.name, 'PreparedFixturesDeniedError');
      assert.ok(lookups.length > 0);
      assert.equal(audits.length, 1);
      assert.ok(audits[0].fixture_resolutions.some(record => record.status === 'failed' && record.fixture_type === 'product'));
      assert.equal(audits[0].fixture_preparation.disposition.status, 'failed');
      assert.ok(audits[0].fixture_preparation.phase.steps.some(step => step.error?.includes('fixture discovery')));
      assert.equal(JSON.stringify(error).includes('malformed-private-fixture'), false);
      assert.equal(JSON.stringify(error).includes('fixture discovery'), false);
      assert.equal(String(error).includes('malformed-private-fixture'), false);
      assert.equal(String(error).includes('fixture discovery'), false);
      assert.equal(calls.some(call => ['create_media_buy', 'get_media_buy_delivery'].includes(call.task)), false);
    }
  });
}

for (const kind of ['format', 'time']) test(`${kind}: repository adapter supplies its trusted sandbox brand for hosted callers`, async () => {
  for (const standalone of [false, true]) {
    const { result, calls } = await execute(kind, { configureBrand: false, standalone });
    assert.equal(standalone ? result.passed : result.overall_passed, true, JSON.stringify(result));
    assert.equal(calls.find(call => call.task === 'create_media_buy').request.brand.domain, 'acmeoutdoor.example');
  }
});

for (const kind of ['format', 'time']) {
  test(`independent security: ${kind} pins authored identity against caller context in full and standalone`, async () => {
    const doc = loadStoryboardFile(path.join(SOURCE, FILES[kind]));
    const callerContext = { account: { ...doc.context.account, sandbox:false },
      sandbox_account: { account_id:'foreign-account', sandbox:false },
      sandbox_brand:{domain:'foreign.example'},brand:{domain:'foreign.example'},catalog_reporting_budget:1 };
    for (const standalone of [false,true]) {
      const { result,calls } = await execute(kind,{standalone,callerContext,minSpend:5000});
      assert.equal(standalone ? result.passed : result.overall_passed,true,JSON.stringify(result));
      const buy = calls.find(c=>c.task==='create_media_buy').request;
      assert.deepEqual(buy.account,doc.context.sandbox_account);
      assert.deepEqual(buy.brand,doc.context.sandbox_brand);
      assert.equal(buy.packages[0].budget,5000);
      assert.equal(buy.packages[0].bid_price,undefined);
    }
  });
  for (const runOverrides of [{sandbox:false},{disable_sandbox:true},{context:{sandbox:false}},
    {context:{__adcp_fixture_reporting_price:{currency:'USD',min_spend_per_package:0}}}]) {
    test(`independent security: ${kind} rejects scope/authority override ${JSON.stringify(runOverrides)} with ZERO ALL HTTP`,async()=>{
      for(const standalone of [false,true]) {
        const {error,allHttp}=await execute(kind,{standalone,runOverrides,localRejection:true});
        assert.ok(error);
        assert.deepEqual(allHttp,[],'scope rejection must precede initialize/capabilities/controller/catalog');
      }
    });
  }
}
