'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');
const { classifyComplianceStep } = require('../server/src/compliance/step-disposition.ts');

const SOURCE = path.join(__dirname, '../static/compliance/source/protocols/media-buy/scenarios');
const FILES = { format: 'advanced_delivery_reporting.yaml', time: 'time_based_delivery_reporting.yaml' };
const TOOLS = ['get_adcp_capabilities', 'get_products', 'sync_accounts', 'create_media_buy', 'get_media_buy_delivery', 'comply_test_controller'];
const load = kind => loadStoryboardFile(path.join(SOURCE, FILES[kind]));

function product(id, features = [], { auction = false, minSpend } = {}) {
  return {
    product_id: id, name: 'StreamHaus sandbox inventory', description: 'Native seller catalog offer',
    publisher_properties: [{ publisher_domain: 'streamhaus.example', selection_type: 'all' }],
    channels: ['olv'], delivery_type: 'non_guaranteed',
    format_options: [
      { format_option_id: 'native-video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } },
      { format_option_id: 'native-image', format_kind: 'image', params: { width: 300, height: 250 } },
    ],
    pricing_options: [{ pricing_option_id: `${id}-cpm`, pricing_model: 'cpm', currency: 'EUR',
      ...(auction ? { floor_price: 17 } : { fixed_price: 17 }),
      ...(minSpend === undefined ? {} : { min_spend_per_package: minSpend }) }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'], expected_delay_minutes: 0, timezone: 'UTC',
      supports_webhooks: false, available_metrics: ['impressions', 'clicks', 'spend', ...(features.includes('time') ? ['time_based_views'] : [])],
      date_range_support: 'date_range', ...(features.includes('format') && { supports_format_breakdown: true }),
    },
  };
}

async function execute(kind, {
  catalog = [product('seller-offer', [kind])], pages, broken, empty = false, missingTime = false,
  discoveryFailure, simulateFailure = false, adversarialAccount = false, matureTimeCommitment = false,
  doc = load(kind), allowBaselineSeeds = false,
} = {}) {
  const calls = [];
  let selected;
  const response = data => ({ success: true, status: 'completed', data });
  const client = {
    resetContext() {},
    async executeTask(task, request) {
      calls.push({ task, request: structuredClone(request) });
      if (task === 'comply_test_controller') {
        if (allowBaselineSeeds && ['seed_product', 'seed_pricing_option'].includes(request.scenario)) return response({ success: true });
        assert.ok(['seed_account', 'simulate_delivery'].includes(request.scenario), 'a reporting feature must never be manufactured through seeding');
        if (request.scenario === 'seed_account') {
          assert.equal(request.params.fixture.sandbox, true);
          return response({ success: true, ...(adversarialAccount && { account: { sandbox: false } }) });
        }
        return simulateFailure ? { success: false, error: 'Advertised simulation failed' } : response({ success: true });
      }
      if (task === 'get_products') {
        assert.equal(request.buying_mode, 'wholesale');
        if (!allowBaselineSeeds) assert.equal(request.account.sandbox, true);
        if (discoveryFailure === 'transport') throw new Error('Discovery transport failed');
        if (discoveryFailure === 'protocol') return { success: false, error: 'Rejected wholesale read' };
        if (discoveryFailure === 'schema') return response({ products: [{ product_id: 'malformed' }] });
        const cursor = request.pagination?.cursor;
        const index = cursor ? Number(cursor) : 0;
        const products = pages ? pages[index] : catalog;
        const metrics = request.filters?.required_metrics ?? [];
        return response({ products: products.filter(entry => metrics.every(metric => entry.reporting_capabilities.available_metrics.includes(metric))),
          cache_scope: 'account', wholesale_feed_version: 'seller-version', context: request.context,
          ...(pages && { pagination: { has_more: index < pages.length - 1, ...(index < pages.length - 1 && { cursor: String(index + 1) }) } }),
          ...(discoveryFailure === 'pagination' && { pagination: { has_more: true } }),
        });
      }
      if (task === 'sync_accounts') {
        assert.equal(allowBaselineSeeds, true, 'only the actual historical baseline synchronizes an account');
        const account = { ...request.accounts[0], action: 'created', account_id: 'seller-account', status: 'active' };
        return response({ accounts: [account], context: request.context });
      }
      if (task === 'create_media_buy') {
        if (!allowBaselineSeeds) assert.deepEqual(request.account, doc.context.sandbox_account, 'purchase uses the immutable qualified sandbox identity');
        const pkg = request.packages[0];
        selected = (pages ? pages.flat() : catalog).find(entry => entry.product_id === pkg.product_id);
        assert.ok(selected, 'purchase must use an actual seller-owned catalog product');
        assert.equal(pkg.pricing_option_id, selected.pricing_options[0].pricing_option_id);
        if (!allowBaselineSeeds) assert.equal(pkg.bid_price, undefined);
        const minimum = selected.pricing_options[0].min_spend_per_package;
        if (minimum !== undefined && pkg.budget < minimum) return { success: false, error: 'Budget below disclosed minimum' };
        return response({ media_buy_id: 'seller-buy', confirmed_at: '2026-10-19T00:00:00Z', revision: 1,
          packages: [{ package_id: 'seller-package', product_id: pkg.product_id, pricing_option_id: pkg.pricing_option_id,
            ...(matureTimeCommitment && { committed_metrics: [{ scope: 'standard', metric_id: 'time_based_views', committed_at: '2026-10-19T00:00:00Z' }] }),
          }], context: request.context });
      }
      if (task === 'get_media_buy_delivery') {
        if (!allowBaselineSeeds) assert.deepEqual(request.account, doc.context.sandbox_account, 'report read uses the immutable qualified sandbox identity');
        const totals = { impressions: 1001, spend: 0 };
        const pkg = { package_id: 'seller-package', impressions: 1001, spend: 0, pricing_model: 'cpm', rate: 17, currency: 'EUR' };
        if (kind === 'format') Object.assign(pkg, { by_format: empty ? [] : [{ format_kind: 'image', spend: 0, impressions: 1001 }],
          by_format_truncated: false,
          by_format_sorted_by: request.reporting_dimensions?.format?.sort_by ?? 'spend',
          by_format_sort_direction: request.reporting_dimensions?.format?.sort_direction ?? 'desc' });
        if ((kind === 'time' || (allowBaselineSeeds && request.requested_metrics?.includes('time_based_views'))) && !missingTime) {
          totals.time_based_views = [{ threshold_seconds: 3, basis: 'in_view', views: 400 }];
          pkg.time_based_views = structuredClone(totals.time_based_views);
        }
        if (kind === 'time' && missingTime) pkg.missing_metrics = [{ scope: 'standard', metric_id: 'time_based_views' }];
        if (matureTimeCommitment) Object.assign(pkg, { measurement_window: 'final', is_final: true, finalized_at: '2026-10-20T01:00:00Z' });
        if (broken === 'missing_disclosure') delete pkg.missing_metrics;
        if (broken === 'injected_impressions') delete totals.impressions;
        if (broken === 'clicks') totals.clicks = 101;
        if (broken === 'package_clicks') pkg.clicks = 101;
        if (broken === 'format_clicks') pkg.by_format[0].clicks = 101;
        if (broken === 'by_format') delete pkg.by_format;
        if (broken === 'truncated') delete pkg.by_format_truncated;
        if (broken === 'sort') delete pkg.by_format_sorted_by;
        if (broken === 'direction') pkg.by_format_sort_direction = 'desc';
        if (broken === 'limit') pkg.by_format.push({ format_kind: 'video_hosted', spend: 0 });
        if (broken === 'time_basis') delete totals.time_based_views[0].basis;
        if (broken === 'package') pkg.package_id = 'other-package';
        const deliveries = [{ media_buy_id: broken === 'buy' ? 'unrequested-buy' : 'seller-buy', status: 'active', totals, by_package: [pkg] }];
        if (broken === 'extra_buy') deliveries.push({ ...structuredClone(deliveries[0]), media_buy_id: 'unrequested-buy' });
        return response({ reporting_period: { start: '2026-10-19T00:00:00Z', end: '2026-10-20T00:00:00Z' },
          media_buy_deliveries: deliveries, context: request.context });
      }
      assert.fail(`Unexpected task ${task}`);
    },
  };
  const result = await runStoryboard('https://seller.example/mcp', doc, {
    _client: client, _profile: { tools: TOOLS, raw_capabilities: { media_buy: { buying_modes: ['brief', 'wholesale'] } } },
    _controllerCapabilities: { detected: true, scenarios: ['seed_account', 'seed_product', 'seed_pricing_option', 'simulate_delivery'] },
    agentTools: TOOLS,
  });
  const graded = result.phases.flatMap(phase => phase.steps.map(step => ({ ...step,
    disposition: classifyComplianceStep(step, `${doc.id}/${phase.phase_id}`),
  })));
  return { result, calls, graded };
}

if (require.main === module) {
for (const kind of ['format', 'time']) {
  test(`${kind}: actual source returns an explicit no-match coverage gap, never seeds a feature`, async () => {
    const { result, calls, graded } = await execute(kind, { catalog: [product('plain-product')] });
    assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'), JSON.stringify(result));
    assert.equal(result.failed_count, 0);
    assert.equal(graded.some(step => step.disposition === 'failed'), false);
    assert.deepEqual(calls.map(call => call.task), ['comply_test_controller', 'get_products']);
    assert.equal(calls[0].request.scenario, 'seed_account');
    assert.equal(classifyComplianceStep({ skipped: true, skip_reason: result.coverage_gaps[0].reason }), 'not_applicable');
  });

  test(`${kind}: independent support found on a later page is exercised with bound seller pricing`, async () => {
    const { result, calls } = await execute(kind, { pages: [
      [product('a-unrelated'), product('b-auction', [kind], { auction: true })],
      [product('z-supporting', [kind])],
    ] });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.deepEqual(calls.filter(call => call.task === 'get_products').map(call => call.request.pagination.cursor), [undefined, '1']);
    assert.equal(calls.find(call => call.task === 'create_media_buy').request.packages[0].product_id, 'z-supporting');
    assert.equal(result.fixture_resolutions.every(record => record.status === 'resolved' && record.strategy === 'discover'), true);
  });

  for (const discoveryFailure of ['transport', 'protocol', 'schema', 'pagination']) {
    test(`${kind}: ${discoveryFailure} discovery failure retains raw and hosted failure evidence`, async () => {
      const { result, calls, graded } = await execute(kind, { discoveryFailure });
      assert.equal(result.overall_passed, false);
      assert.ok(result.phases.flatMap(phase => phase.steps).some(step => !step.passed && !step.skipped), JSON.stringify(result));
      // SDK labels failed resolution attempts as synthetic controller steps;
      // existing hosted policy retains them as setup gaps. Do not silently
      // change that accounting or turn them into applicability skips.
      assert.deepEqual([...new Set(graded.filter(step => !step.passed && !step.skipped).map(step => step.disposition))], ['setup_gap']);
      assert.equal(graded.some(step => step.skip_reason === 'fixture_unsatisfied'), false);
      assert.equal(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied') ?? false, false);
      assert.deepEqual(calls.map(call => call.task), ['comply_test_controller', 'get_products']);
    });
  }

  test(`${kind}: advertised simulation failure stays failed`, async () => {
    const { result, graded } = await execute(kind, { simulateFailure: true });
    assert.equal(result.overall_passed, false);
    assert.ok(graded.some(step => step.task === 'comply_test_controller' && step.disposition === 'failed'));
  });

  for (const dropInjected of [false, true]) {
    test(`${kind}: accepted injected totals remain accountable without native impression advertisement (${dropInjected})`, async () => {
      const offer = product('native-without-impression-advertisement', [kind]);
      offer.reporting_capabilities.available_metrics = offer.reporting_capabilities.available_metrics.filter(metric => metric !== 'impressions');
      const { result, graded } = await execute(kind, {
        catalog: [offer], ...(dropInjected && { broken: 'injected_impressions' }),
      });
      // The controller contract requires subsequent cumulative reads to
      // reflect accepted injection. This does not establish native measurement
      // support or invent format/time grain observations.
      assert.equal(result.overall_passed, !dropInjected, JSON.stringify(result));
      if (dropInjected) assert.ok(graded.some(step => step.task === 'get_media_buy_delivery' && step.disposition === 'failed'));
    });
  }

  test(`${kind}: qualification counterexample preserves disclosed minimum-spend rejection`, async () => {
    const { result, graded } = await execute(kind, { catalog: [product('high-minimum', [kind], { minSpend: 5000 })] });
    // This is an explicit merge blocker for the draft, not acceptable final
    // grading. Current bindings expose identity without the commercial oracle
    // needed to build a valid buy. Never skip or rewrite this raw failure.
    assert.equal(result.overall_passed, false);
    assert.ok(graded.some(step => step.step_id === 'create_buy' && step.disposition === 'failed'));
    assert.equal(result.fixture_resolutions.every(record => record.status === 'resolved'), true);
  });

  test(`${kind}: controller response fields cannot change the authored sandbox scope`, async () => {
    const { result, calls } = await execute(kind, { adversarialAccount: true });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(calls.some(call => call.task === 'sync_accounts'), false);
  });

  for (const broken of ['buy', 'extra_buy', 'package']) {
    test(`${kind}: unrequested ${broken} report cannot pass`, async () => {
      const { result, graded } = await execute(kind, { broken });
      assert.equal(result.overall_passed, false);
      assert.ok(graded.some(step => step.task === 'get_media_buy_delivery' && step.disposition === 'failed'));
    });
  }
}

test('format: empty observed grains remain valid with all required companions', async () => {
  const { result } = await execute('format', { empty: true });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
});

for (const broken of ['by_format', 'truncated', 'sort', 'direction', 'limit', 'clicks', 'package_clicks', 'format_clicks', 'package']) {
  test(`format: selected broken ${broken} is graded as a failure`, async () => {
    const { result, graded } = await execute('format', { broken });
    assert.equal(result.overall_passed, false);
    assert.ok(graded.some(step => step.step_id === 'get_narrowed_format_delivery' && step.disposition === 'failed'), JSON.stringify(result));
  });
}

for (const missingTime of [false, true]) {
  test(`time: legal seller-defined measurements or unavailable-data disclosure (${missingTime})`, async () => {
    const { result } = await execute('time', { missingTime });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
  });
}

test('time: a returned entry missing its mandatory basis fails schema validation', async () => {
  const { result, graded } = await execute('time', { broken: 'time_basis' });
  assert.equal(result.overall_passed, false);
  assert.ok(graded.some(step => step.step_id === 'get_narrowed_time_delivery' && step.disposition === 'failed'), JSON.stringify(result));
});

test('qualification counterexample: matured committed time data and missing disclosure can both disappear', async () => {
  const offer = product('mature-time', ['time']);
  offer.reporting_capabilities.measurement_windows = [{ window_id: 'final', duration_days: 0, expected_availability_days: 0, is_guarantee_basis: true }];
  const { result, graded } = await execute('time', {
    catalog: [offer], missingTime: true, matureTimeCommitment: true, broken: 'missing_disclosure',
  });
  // Deliberately preserved false pass: this is a merge-blocking qualification
  // result, not the required final behavior. Bindings and schema checks alone
  // cannot perform the applicable cross-step reporting-contract reconciliation.
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.ok(graded.some(step => step.step_id === 'get_narrowed_time_delivery' && step.disposition === 'passed'));
});
}

module.exports = { execute, product };
