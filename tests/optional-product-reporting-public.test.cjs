'use strict';

require('./helpers/ajv-maglev-guard.cjs');

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
const { inspect } = require('node:util');
const { loadStoryboardFile, prepareStoryboardFixtures, runStoryboard: runRawStoryboard } = require('@adcp/sdk/testing');
const { runCatalogReportingStoryboard: runStoryboard, runCatalogReportingStoryboardStep: runStoryboardStep, withReportingInvocationGrant, withHostedReportingBudget, HOSTED_REPORTING_RESPONSE_BYTES } = require('../server/src/compliance/catalog-reporting-runner.ts');

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

async function execute(kind, { adversarialAccount = false, broken, configureBrand = true, rawCaller = false, minSpend, standalone = false, decoy = false, hostDenied = false, suppliedState = false, callerContext, runOverrides = {}, localRejection = false, discoveryFailure = false, failPreflightOnce = false, prepareOnly = false, hostedBudget = false, responsePaddingBytes = 0 } = {}) {
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
  let capabilityCalls = 0;

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
        if (failPreflightOnce && ++capabilityCalls === 2) {
          return Response.json({ jsonrpc: '2.0', id: message.id,
            result: { isError: true, content: [{ type: 'text', text: 'Controlled preflight capability failure' }] } });
        }
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
        assert.equal(Object.hasOwn(request, 'currency'), false, 'create_media_buy has no top-level currency');
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
    if (message.method === 'tools/call' && message.params.name === 'get_products' && responsePaddingBytes) result._meta = { budget_probe_padding: 'x'.repeat(responsePaddingBytes) };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
  };

  let options = {
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
  if (hostedBudget) options = withHostedReportingBudget(doc, options);
  if (prepareOnly) return { prepared: await prepareStoryboardFixtures(ENDPOINT, doc, options), calls };
  let result;
  try {
    result = rawCaller ? await runRawStoryboard(ENDPOINT, doc, options) : standalone ? await runStoryboardStep(ENDPOINT, doc, 'create_buy', options) : await runStoryboard(ENDPOINT, doc, options);
  } catch (error) {
    if (!hostDenied && !suppliedState && !localRejection) throw error;
    if (runOverrides.signal?.aborted) assert.equal(error, runOverrides.signal.reason);
    else if (hostDenied) assert.equal(error.name, 'PreparedFixturesDeniedError');
    else if (suppliedState) assert.match(error.message, /must be owned by this invocation/);
    else if (error.name !== 'PreparedFixturesDeniedError') assert.match(error.message, /sandbox scope|one seller/i);
    return { error, calls, audits, lookups, methods, allHttp };
  }
  assert.ok(methods.includes('initialize') && methods.includes('tools/call'), 'the real public MCP transport executes');
  assert.equal(calls.some(call => call.task === 'sync_accounts'), false, 'seeded sandbox setup needs no mutable account-sync extraction');
  const terminalPreparation = result.fixture_resolutions?.some(record => record.status === 'failed' || record.status === 'unsatisfied');
  assert.deepEqual(calls.filter(call => call.task === 'comply_test_controller' && call.request.scenario !== 'list_scenarios').map(call => call.request.scenario), !terminalPreparation && (!rawCaller || configureBrand) && !standalone ? SCENARIOS : ['seed_account'], JSON.stringify(result));
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
      assert.equal(Object.hasOwn(buy, 'currency'), false);
      assert.equal(buy.packages[0].pricing_option_id, `native-${kind}-cpm`);
      assert.equal(buy.packages[0].budget, 5000);
      assert.equal(buy.packages[0].bid_price, undefined);
    }
  });
  test(`${kind}: host denial returns typed access error and retains complete private audit evidence`, async () => {
    for (const standalone of [false, true]) {
      const { error, calls, audits, lookups } = await execute(kind, { hostDenied: true, standalone });
      assert.equal(error.name, 'PreparedFixturesDeniedError');
      assert.equal(lookups.length, 0, 'adcp-client#3435: the adapter preflight precedes any SDK preparation hook; do not claim hook invocation');
      assert.equal(calls.some(call => call.task === 'create_media_buy'), false);
      assert.equal(audits.length, 1);
      assert.deepEqual(audits[0].fixture_resolutions, [], 'no preparation or seller identity exists before contact');
      const steps = standalone ? [audits[0]] : audits[0].phases.flatMap(phase => phase.steps);
      assert.ok(steps.some(step => step.validations.some(validation => validation.check === 'prepared_fixtures_authorization' && validation.passed === false)));
      // A standalone audit is a complete step record, not a run-result envelope.
      assert.equal(JSON.stringify(error).includes(`native-${kind}-offer`), false);
      assert.equal(inspect(error).includes(`native-${kind}-offer`), false);
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
      assert.equal(lookups.length, 0, 'adcp-client#3435: the adapter preflight precedes any SDK preparation hook; do not claim hook invocation');
      assert.equal(audits.length, 1);
      assert.deepEqual(audits[0].fixture_resolutions, [], 'precontact refusal cannot invent a failed seller preparation');
      assert.deepEqual(calls, []);
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
        if (Object.keys(runOverrides.context ?? {}).some(key => key.startsWith('__adcp_fixture_')))
          assert.equal(error.name, 'PreparedFixturesDeniedError');
        else assert.match(error.message, /sandbox scope|one seller/);
        assert.deepEqual(allHttp,[],'scope rejection must precede initialize/capabilities/controller/catalog');
      }
    });
  }
}

for (const standalone of [false, true]) for (const [name, authorizer] of [
  ['throws', () => { throw new Error('HOST_PRIVATE_8336'); }],
  ['undefined', () => undefined],
  ['nonliteral true', () => ({ authorized: 'true', detail: 'HOST_PRIVATE_8336' })],
  ['literal true', () => ({ authorized: true })],
]) test(`precontact hook API gap: ${name} ${standalone ? 'step' : 'full'} fails closed with no HTTP (not callback qualification)`, async () => {
  let calls = 0;
  const audits = [];
  const { error, allHttp } = await execute('format', { standalone, localRejection: true,
    runOverrides: { prepared_fixtures_authorizer: (...args) => { calls++; return authorizer(...args); },
      prepared_fixtures_audit_sink: record => audits.push(record) } });
  assert.equal(error.name, 'PreparedFixturesDeniedError');
  assert.equal(error.refusalCode, 'authorizer_denied');
  assert.deepEqual(allHttp, []);
  assert.equal(calls, 0, 'unsupported hook is never called with fabricated bindings');
  assert.equal(audits.length, 1);
  assert.equal(inspect(error).includes('HOST_PRIVATE_8336'), false);
  assert.equal(inspect(error).includes('seller.example'), false);
});

test('invocation grant rejects a lookup after normal completion and exception', async () => {
  for (const throws of [false, true]) {
    let authorize;
    const operation = withReportingInvocationGrant(async grant => {
      authorize = grant;
      assert.deepEqual(await grant(), { authorized: true });
      if (throws) throw new Error('operation failed');
    });
    if (throws) await assert.rejects(operation, /operation failed/); else await operation;
    assert.equal((await authorize()).authorized, false);
  }
});

test('two concurrent invocation grants close independently', async () => {
  let authorizeA, authorizeB, finishA, finishB;
  const first = withReportingInvocationGrant(async grant => { authorizeA = grant; await new Promise(resolve => { finishA = resolve; }); });
  const second = withReportingInvocationGrant(async grant => { authorizeB = grant; await new Promise(resolve => { finishB = resolve; }); });
  assert.equal((await authorizeA()).authorized, true);
  assert.equal((await authorizeB()).authorized, true);
  finishA(); await first;
  assert.equal((await authorizeA()).authorized, false);
  assert.equal((await authorizeB()).authorized, true);
  finishB(); await second;
  assert.equal((await authorizeB()).authorized, false);
});

for (const kind of ['format', 'time']) test(`${kind}: native fallback after a failed preflight retains trusted sandbox identity`, async () => {
  const { calls } = await execute(kind, { failPreflightOnce: true,
    runOverrides: { profile: undefined },
    callerContext: { account: { account_id: 'foreign-account', sandbox: false },
      sandbox_brand: { domain: 'foreign.example' }, sandbox_account: { sandbox: false } } });
  const buy = calls.find(c => c.task === 'create_media_buy');
  assert.ok(buy, 'the recovered native path actually executes a purchase');
  assert.equal(buy.request.account.sandbox, true);
  assert.equal(buy.request.account.operator, 'pinnacle-agency.example');
});

for (const value of [null, false, 0, '']) test(`malformed supplied authorizer field ${JSON.stringify(value)} fails closed before HTTP`, async () => {
  const { error, allHttp } = await execute('format', { localRejection: true,
    runOverrides: { prepared_fixtures_authorizer: value } });
  assert.equal(error.name, 'PreparedFixturesDeniedError');
  assert.equal(error.refusalCode, 'authorizer_denied');
  assert.deepEqual(allHttp, []);
});

for (const standalone of [false, true]) test(`pre-aborted ${standalone ? 'step' : 'full'} reporting invocation has zero HTTP`, async () => {
  const { error, allHttp } = await execute('format', { standalone, localRejection: true,
    runOverrides: { signal: AbortSignal.abort() } });
  assert.equal(error.name, 'AbortError');
  assert.deepEqual(allHttp, []);
});

test('an audit-sink exception cannot undo refusal or leak into inspect(error)', async () => {
  const { error, allHttp } = await execute('format', { localRejection: true,
    runOverrides: { prepared_fixtures_authorizer: () => ({ authorized: true }),
      prepared_fixtures_audit_sink: () => { throw new Error('PRIVATE_AUDIT_8336'); } } });
  assert.equal(error.name, 'PreparedFixturesDeniedError');
  assert.equal(inspect(error).includes('PRIVATE_AUDIT_8336'), false);
  assert.deepEqual(allHttp, []);
});

for (const kind of ['format', 'time']) for (const minSpend of [undefined, 0, 5000])
  test(`${kind}: public prepared price snapshot preserves minimum ${String(minSpend)} without exposing protected captures in run results`, async () => {
    const { prepared } = await execute(kind, { minSpend, prepareOnly: true });
    assert.equal(prepared.disposition.status, 'resolved');
    const captured = prepared.captures.__adcp_fixture_reporting_price;
    assert.equal(Object.hasOwn(captured, 'min_spend_per_package'), minSpend !== undefined);
    assert.equal(captured.min_spend_per_package, minSpend);
    assert.equal(captured.currency, 'EUR');
    assert.equal(prepared.captures.__adcp_fixture_reporting_currency, 'EUR');
    assert.equal(captured.pricing_option_id, `native-${kind}-cpm`);
  });

test('hosted reporting cap preserves tighter caller limits, safe transport and cancellation, and leaves other scopes unchanged', () => {
  const doc = loadStoryboardFile(path.join(SOURCE, FILES.format));
  const signal = new AbortController().signal;
  const fetchFn = async () => new Response('{}');
  const options = { signal, transport: { maxResponseBytes: 8192, fetchFn } };
  const tightened = withHostedReportingBudget(doc, options);
  assert.equal(tightened.transport.maxResponseBytes, 8192);
  assert.equal(tightened.transport.fetchFn, fetchFn);
  assert.equal(tightened.signal, signal);
  assert.equal(withHostedReportingBudget(doc, {}).transport.maxResponseBytes, HOSTED_REPORTING_RESPONSE_BYTES);
  for (const maxResponseBytes of [0, -1, NaN, Infinity, -Infinity])
    assert.equal(withHostedReportingBudget(doc, { transport: { maxResponseBytes } }).transport.maxResponseBytes, HOSTED_REPORTING_RESPONSE_BYTES,
      'SDK zero disables its cap and nonfinite/nonpositive values are not tighter');
  assert.equal(withHostedReportingBudget({ ...doc, id: 'other/scenario' }, options), options);
  assert.equal(withHostedReportingBudget({ ...doc, fixture_resolution: undefined }, options), options);
});

for (const standalone of [false, true]) test(`hosted ${standalone ? 'step' : 'full'} reporting enforces the real public response byte cap`, async () => {
  const below = await execute('format', { standalone, hostedBudget: true, responsePaddingBytes: 128 * 1024 });
  assert.equal(standalone ? below.result.passed : below.result.overall_passed, true);
  const above = await execute('format', { standalone, hostedBudget: true, responsePaddingBytes: HOSTED_REPORTING_RESPONSE_BYTES + 1 });
  assert.equal(standalone ? above.result.passed : above.result.overall_passed, false);
  assert.equal(above.calls.some(c => c.task === 'create_media_buy'), false);
  assert.ok(above.result.fixture_resolutions.some(record => record.status === 'failed'));
  assert.match(JSON.stringify(above.result.fixture_resolutions), /byte|large|limit/i, 'retain actual response-budget failure evidence');
  assert.equal(above.result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false, false);
});

test('concurrent actual reporting invocations retain independent accounts, selected prices and budgets', async () => {
  const [format, time] = await Promise.all([
    execute('format', { minSpend: 5000 }),
    execute('time', { minSpend: 0 }),
  ]);
  for (const [kind, probe, budget] of [['format', format, 5000], ['time', time, 1000]]) {
    assert.equal(probe.result.overall_passed, true);
    const buy = probe.calls.find(call => call.task === 'create_media_buy').request;
    assert.equal(buy.packages[0].product_id, `native-${kind}-offer`);
    assert.equal(buy.packages[0].pricing_option_id, `native-${kind}-cpm`);
    assert.equal(buy.packages[0].budget, budget);
    const authored = loadStoryboardFile(path.join(SOURCE, FILES[kind]));
    assert.deepEqual(buy.account, authored.context.sandbox_account);
  }
});
