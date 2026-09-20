#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { runStoryboard } = require('@adcp/sdk/testing');

const storyboardPath = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'universal',
  'webhook-emission.yaml'
);

function loadStoryboard() {
  return YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
}

const schemaRoot = path.join(__dirname, '..', 'static', 'schemas', 'source');
const triggerIds = [
  'trigger_webhook_operation',
  'trigger_operation_id_echo',
  'trigger_idempotent_webhook_initial',
  'trigger_idempotent_webhook_replay',
  'trigger_retry_scenario',
  'trigger_signed_webhook',
];

function allSteps(storyboard) {
  return storyboard.phases.flatMap(phase => phase.steps);
}

// Fail closed: a missing/dynamic reference or a missing transitive $ref must
// throw, never count as successful schema validation with a "skipped" result.
function readSchema(ref) {
  assert.equal(typeof ref, 'string');
  assert.ok(!ref.startsWith('$'), `Unresolved schema reference: ${ref}`);
  return JSON.parse(fs.readFileSync(path.join(schemaRoot, ref.replace(/^\/schemas\//, '')), 'utf8'));
}

const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
addFormats(ajv);
async function compileSchema(ref) {
  const schema = readSchema(ref);
  return ajv.getSchema(schema.$id) ?? ajv.compileAsync(schema);
}

test('webhook triggers bind product and pricing IDs from preceding, tool-gated discovery', () => {
  const steps = allSteps(loadStoryboard());
  const discovery = steps.find(step => step.id === 'get_products_discovery');
  assert.ok(discovery, 'discover a real product before triggering webhooks');
  assert.equal(discovery.task, 'get_products');
  assert.equal(discovery.requires_tool, 'get_products');
  assert.equal(discovery.sample_request.filters?.is_fixed_price, undefined);
  assert.deepEqual(discovery.context_outputs, [
    { path: 'task_completion.products', key: 'products' },
    { path: 'task_completion.products[0].product_id', key: 'product_id' },
    { path: 'task_completion.products[0].pricing_options[0].pricing_option_id', key: 'pricing_option_id' },
  ]);
  for (const id of triggerIds) {
    const trigger = steps.find(step => step.id === id);
    assert.ok(steps.indexOf(discovery) < steps.indexOf(trigger), id);
    assert.equal(trigger.sample_request.packages[0].product_id, '$context.product_id', id);
    assert.equal(trigger.sample_request.packages[0].pricing_option_id, '$context.pricing_option_id', id);
  }
});

test('every webhook storyboard request, response and payload schema resolves and compiles', async () => {
  for (const step of allSteps(loadStoryboard())) {
    if (['get_adcp_capabilities', 'get_products'].includes(step.task) || triggerIds.includes(step.id)) {
      assert.ok(step.schema_ref, `${step.id} requires a request schema`);
      assert.ok(step.response_schema_ref, `${step.id} requires a response schema`);
    }
    for (const field of ['schema_ref', 'response_schema_ref', 'webhook_payload_schema_ref']) {
      if (step[field] !== undefined) {
        assert.equal(typeof await compileSchema(step[field]), 'function', `${step.id}.${field}`);
      }
    }
  }
});

test('schema guard rejects the old test-kit references and missing schema paths', async () => {
  for (const ref of ['$test_kit.schemas.primary_request', '$test_kit.schemas.primary_response']) {
    await assert.rejects(compileSchema(ref), /Unresolved schema reference/);
  }
  await assert.rejects(compileSchema('media-buy/missing-webhook-schema.json'), /ENOENT/);
});

function catalogProduct(productId = 'outdoornet-webhook-product', pricingId = 'outdoornet-webhook-price') {
  return {
    product_id: productId,
    name: 'OutdoorNet display',
    description: 'Display inventory for Acme Outdoor',
    publisher_properties: [{ publisher_domain: 'outdoormagazine.example', selection_type: 'all' }],
    delivery_type: 'guaranteed',
    format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
    pricing_options: [{ pricing_option_id: pricingId, pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 60,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    },
  };
}

// Exercise the actual source steps through the published SDK. Receiver/JWKS
// assertions are covered separately; this slice isolates the catalog-to-trigger
// contract without waiting for outbound deliveries or accessing a remote agent.
async function runTriggers(source, products, tools = ['get_adcp_capabilities', 'get_products', 'create_media_buy'], discovery = {}) {
  const calls = [];
  const storyboard = {
    ...source,
    prerequisites: undefined,
    phases: source.phases.map(phase => ({
      ...phase,
      steps: phase.steps.filter(step => step.task === 'get_adcp_capabilities' ||
        step.id === 'get_products_discovery' || triggerIds.includes(step.id)),
    })).filter(phase => phase.steps.length),
  };
  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: { tools, raw_capabilities: { supported_protocols: ['media_buy'] } },
    agentTools: tools,
    webhook_receiver: { mode: 'loopback_mock' },
    _client: {
      agent: { id: 'catalog-seller', agent_uri: 'https://agent.example/mcp' },
      executor: {
        async pollTaskCompletion(_agent, taskId) {
          calls.push({ task: 'poll_task_completion', taskId });
          return discovery.completion ?? {
            success: true,
            data: { status: 'completed', products, cache_scope: 'account' },
          };
        },
      },
      resetContext() {},
      async getAdcpCapabilities() {
        return { success: true, data: { supported_protocols: ['media_buy'] } };
      },
      async getProducts(request) {
        calls.push({ task: 'get_products', request });
        if (discovery.status) {
          return { success: true, data: { status: discovery.status, task_id: 'catalog-discovery-task' } };
        }
        return { success: true, data: { products, cache_scope: 'account' } };
      },
      async createMediaBuy(request) {
        calls.push({ task: 'create_media_buy', request });
        const pkg = request.packages[0];
        if (!products.some(product => product.product_id === pkg.product_id &&
          product.pricing_options.some(price => price.pricing_option_id === pkg.pricing_option_id))) {
          return { success: false, data: { errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'Unknown catalog product' }] } };
        }
        return {
          success: true,
          data: { status: 'completed', media_buy_id: 'webhook-buy', confirmed_at: null, revision: 1,
            packages: [{ package_id: 'webhook-package' }], replayed: true },
        };
      },
    },
  });
  return { result, calls };
}

test('SDK dispatches all six triggers with discovered IDs and schema-valid requests', async () => {
  const source = loadStoryboard();
  // Two runs with different seller IDs prove this is response binding, not a
  // fixture constant or a context value leaking from an earlier run.
  for (const suffix of ['a', 'b']) {
    const product = catalogProduct(`seller-product-${suffix}`, `seller-price-${suffix}`);
    if (suffix === 'b') {
      delete product.pricing_options[0].fixed_price;
      product.pricing_options[0].floor_price = 5;
    }
    const { result, calls } = await runTriggers(source, [product]);
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases.flatMap(phase => phase.steps)
      .filter(step => !step.passed).map(step => ({ id: step.step_id, error: step.error, validations: step.validations }))));
    assert.equal(result.skipped_count, 0);
    assert.equal(calls[0].task, 'get_products');
    const buys = calls.filter(call => call.task === 'create_media_buy');
    assert.equal(buys.length, triggerIds.length);
    for (const { request } of buys) {
      assert.equal(request.packages[0].product_id, product.product_id);
      assert.equal(request.packages[0].pricing_option_id, product.pricing_options[0].pricing_option_id);
      assert.equal(Date.parse(request.end_time) - Date.parse(request.start_time), 7 * 24 * 60 * 60 * 1000);
      if (suffix === 'b') assert.ok(request.packages[0].bid_price >= 5);
      assert.ok(!JSON.stringify(request).includes('$context.'));
      assert.ok(!JSON.stringify(request).includes('{{runner.'));
      const validate = await compileSchema('media-buy/create-media-buy-request.json');
      assert.equal(validate(request), true, JSON.stringify(validate.errors));
    }
    const initial = buys[2].request;
    const replay = buys[3].request;
    assert.equal(initial.idempotency_key, replay.idempotency_key);
    assert.deepEqual(initial.packages, replay.packages);
    assert.deepEqual(initial.push_notification_config, replay.push_notification_config);
    assert.equal(new Set([calls[0].request.idempotency_key, ...buys.map(call => call.request.idempotency_key)]).size, 6);
  }
});

test('asynchronous discovery is completed before any webhook buy is dispatched', async () => {
  for (const status of ['submitted', 'working']) {
    const product = catalogProduct(`async-product-${status}`, `async-price-${status}`);
    if (status === 'working') {
      delete product.pricing_options[0].fixed_price;
      product.pricing_options[0].floor_price = 9;
    }
    const { result, calls } = await runTriggers(loadStoryboard(), [product], undefined, { status });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases.flatMap(phase => phase.steps)
      .filter(step => !step.passed).map(step => ({ id: step.step_id, error: step.error, validations: step.validations }))));
    assert.equal(result.skipped_count, 0);
    assert.deepEqual(calls.slice(0, 2).map(call => call.task), ['get_products', 'poll_task_completion']);
    assert.equal(calls[1].taskId, 'catalog-discovery-task');
    const buys = calls.filter(call => call.task === 'create_media_buy');
    assert.equal(buys.length, triggerIds.length);
    for (const { request } of buys) {
      assert.equal(request.packages[0].product_id, product.product_id);
      assert.equal(request.packages[0].pricing_option_id, product.pricing_options[0].pricing_option_id);
      if (status === 'working') assert.ok(request.packages[0].bid_price >= 9);
    }
  }
});

test('unprefixed captures reproduce the async discovery failure without polling', async () => {
  const source = loadStoryboard();
  const discovery = allSteps(source).find(step => step.id === 'get_products_discovery');
  for (const output of discovery.context_outputs) output.path = output.path.replace(/^task_completion\./, '');
  const { result, calls } = await runTriggers(source, [catalogProduct()], undefined, { status: 'submitted' });
  assert.equal(result.overall_passed, false);
  assert.deepEqual(calls.map(call => call.task), ['get_products']);
  const step = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === discovery.id);
  assert.ok(step.validations.some(validation => validation.check === 'capture_path_not_resolvable'));
});

test('failed or empty async completion never dispatches webhook buys', async () => {
  for (const completion of [
    { success: false, error: 'Discovery task failed' },
    { success: true, data: { status: 'completed', products: [], cache_scope: 'account' } },
    { success: true, data: { status: 'completed', products: [{ ...catalogProduct(), pricing_options: [] }], cache_scope: 'account' } },
  ]) {
    const { result, calls } = await runTriggers(loadStoryboard(), [catalogProduct()], undefined,
      { status: 'submitted', completion });
    assert.equal(result.overall_passed, false);
    assert.deepEqual(calls.map(call => call.task), ['get_products', 'poll_task_completion']);
    const step = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_products_discovery');
    assert.equal(step.passed, false);
    const expected = completion.success ? 'capture_path_not_resolvable' : 'capture_task_failed';
    assert.ok(step.validations.some(validation => validation.check === expected), JSON.stringify(step.validations));
  }
});

test('old missing-discovery behavior ships test-product and the seller rejects it', async () => {
  const source = loadStoryboard();
  for (const phase of source.phases) {
    phase.steps = phase.steps.filter(step => step.id !== 'get_products_discovery');
    for (const step of phase.steps.filter(step => triggerIds.includes(step.id))) {
      delete step.sample_request.packages;
    }
  }
  const { result, calls } = await runTriggers(source, [catalogProduct()]);
  const buys = calls.filter(call => call.task === 'create_media_buy');
  assert.ok(buys.length > 0);
  assert.equal(buys[0].request.packages[0].product_id, 'test-product');
  assert.equal(buys[0].request.packages[0].pricing_option_id, 'test-pricing');
  assert.equal(result.overall_passed, false);
  assert.ok(JSON.stringify(result.phases).includes('PRODUCT_NOT_FOUND'));
});

test('missing product or pricing captures fail closed without dispatching a buy', async () => {
  for (const products of [[], [{ ...catalogProduct(), product_id: '' }],
    [{ ...catalogProduct(), pricing_options: [] }],
    [{ ...catalogProduct(), pricing_options: [{ pricing_option_id: '', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }] }]]) {
    const { result, calls } = await runTriggers(loadStoryboard(), products);
    assert.equal(result.overall_passed, false);
    assert.deepEqual(calls.map(call => call.task), ['get_products']);
    const discovery = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_products_discovery');
    assert.equal(discovery.passed, false);
  }
});

test('agents without sales tools skip product discovery and all sales triggers', async () => {
  const { result, calls } = await runTriggers(loadStoryboard(), [], ['get_adcp_capabilities', 'get_signals']);
  assert.deepEqual(calls, []);
  assert.equal(result.failed_count, 0);
  const discovery = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_products_discovery');
  assert.equal(discovery.skipped, true);
});

test('all trigger schemas reject malformed requests and responses without skipped validation', async () => {
  const { validateStep } = require('../scripts/lint-storyboard-sample-request-schema.cjs');
  const steps = allSteps(loadStoryboard());
  for (const id of triggerIds) {
    const step = steps.find(step => step.id === id);
    assert.equal(step.schema_ref, 'media-buy/create-media-buy-request.json', id);
    assert.equal(step.response_schema_ref, 'media-buy/create-media-buy-response.json', id);
    const sample = await validateStep({ schemaRef: step.schema_ref, payload: step.sample_request });
    assert.deepEqual(sample, { ok: true }, `${id}: ${JSON.stringify(sample)}`);
    const request = await compileSchema(step.schema_ref);
    const response = await compileSchema(step.response_schema_ref);
    assert.equal(request({}), false, id);
    assert.equal(response({}), false, id);
    assert.equal(response({ status: 'completed', media_buy_id: 'webhook-buy', confirmed_at: null, revision: 1,
      packages: [{ package_id: 'webhook-package' }] }), true, JSON.stringify(response.errors));
  }
  // This is the old lint's actual fail-open result. Merely asserting ok would
  // miss #7610; the guard above insists that a validator really ran.
  const old = await validateStep({ schemaRef: '$test_kit.schemas.primary_request', payload: {} });
  assert.equal(old.skipped, 'schema_not_found');
  assert.notDeepEqual(old, { ok: true });
});

test('synchronous completion branch family requires wholesale product discovery', () => {
  const storyboard = loadStoryboard();
  const phaseIds = [
    'synchronous_completion_success_path',
    'synchronous_completion_rejection_path',
    'synchronous_completion_assertion',
  ];

  for (const phaseId of phaseIds) {
    assert.deepEqual(
      storyboard.phases.find(phase => phase.id === phaseId).requires_capability,
      { path: 'media_buy.buying_modes', contains: 'wholesale' },
      phaseId
    );
  }
});

test('synchronous completion assertion is not applicable to a signals-only agent', async () => {
  const source = loadStoryboard();
  const phaseIds = new Set([
    'synchronous_completion_success_path',
    'synchronous_completion_rejection_path',
    'synchronous_completion_assertion',
  ]);
  const storyboard = {
    ...source,
    requires: undefined,
    prerequisites: undefined,
    phases: [
      ...source.phases
        .filter(phase => phaseIds.has(phase.id))
        .map(phase => ({
          ...phase,
          steps: phase.steps.map(step => ({ ...step, sample_request: undefined })),
        })),
      {
        id: 'control',
        title: 'Control',
        optional: true,
        skip_if: 'true',
        steps: [{ id: 'unused', title: 'Unused', task: 'get_signals' }],
      },
    ],
  };

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools: ['get_adcp_capabilities', 'get_signals'],
      raw_capabilities: { supported_protocols: ['signals'] },
    },
    agentTools: ['get_adcp_capabilities', 'get_signals'],
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 4);
  for (const phase of result.phases.filter(phase => phase.phase_id !== 'control')) {
    assert.equal(phase.steps[0].skip.reason, 'not_applicable', phase.phase_id);
  }
  const assertion = result.phases.find(phase => phase.phase_id === 'synchronous_completion_assertion');
  assert.equal(assertion.steps[0].skip_reason, 'not_applicable');
});
