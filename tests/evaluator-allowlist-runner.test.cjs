#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseStoryboard, runStoryboard, buildComplianceBundleResults } = require('@adcp/sdk/testing');
const creativeScenariosPath = path.join(__dirname, '..', 'static', 'compliance', 'source', 'protocols', 'creative', 'scenarios');

// Use the complete authored fixture and the real loader/runner. In particular,
// the loader's name -> key context-output normalization and required capture
// failures must remain active; a hand-built phase cannot test applicability.
async function runEvaluatorBoundary({
  support = true,
  discoverySupport = support,
  missingCatalog,
  attack,
  optionalFailure = false,
  preflightFailure = false,
  catalog,
  generation = true,
  transformation = false,
  testKit,
  governanceEnforcement,
  expectedTarget = 'display-build',
  expectedManifest = { format_kind: 'image', assets: {} },
} = {}) {
  const storyboard = parseStoryboard(fs.readFileSync(path.join(creativeScenariosPath, 'evaluator_auth.yaml'), 'utf8'));
  const capabilities = {
    adcp: { major_versions: [3], idempotency: { supported: false },
      ...(governanceEnforcement && { governance_enforcement: governanceEnforcement }) },
    supported_protocols: ['creative', 'governance'],
    creative: {
      ...(support !== undefined && { supports_evaluator: support }),
      supports_generation: generation,
      supports_transformation: transformation,
      supported_formats: catalog ?? [{
        capability_id: 'display-build',
        format: { format_kind: 'image', params: {}, technical_requirements_complete: true },
      }],
    },
    governance: { creative_features: [{ feature_id: 'visual-quality', type: 'quantitative' }] },
    experimental_features: ['creative.evaluator'],
  };
  const previews = capabilities.creative.supported_formats.filter(route => route.operations?.includes('preview'));
  if (previews.length) capabilities.creative.preview = { routes: previews.map(route => ({ capability_id: route.capability_id, rendering_origin: 'agent_approximation' })) };
  if (support === 'absent') delete capabilities.creative.supports_evaluator;
  const discovery = structuredClone(capabilities);
  if (discoverySupport === 'absent') delete discovery.creative.supports_evaluator;
  else discovery.creative.supports_evaluator = discoverySupport;
  if (missingCatalog === 'build') { capabilities.creative.supported_formats = []; discovery.creative.supported_formats = []; }
  if (missingCatalog === 'feature') discovery.governance.creative_features = [];
  // Unsupported agents need neither a build tool nor a controller to skip this
  // optional feature; evaluate applicability before those requirements.
  const tools = support === true || preflightFailure
    ? ['get_adcp_capabilities', 'build_creative', 'comply_test_controller']
    : ['get_adcp_capabilities'];
  const requests = [];
  const trafficQueries = [];
  let recordedCalls = [];
  let unavailable = false;
  let capabilityAttempts = 0;
  const successData = context => ({
    creatives: [{ variants: [{
      build_variant_id: 'variant-boundary',
      creative_manifest: { format_kind: 'image', assets: {} },
      rank: 1,
      recommended: true,
      eval: { features: [{ feature_id: 'visual-quality', value: 0.9 }] },
    }] }],
    context,
  });
  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: preflightFailure ? undefined : { tools, raw_capabilities: capabilities },
    _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic', 'force_upstream_unavailable'] },
    agentTools: preflightFailure ? undefined : tools,
    skip_controller_seeding: true,
    test_kit: testKit,
    _client: {
      resetContext() {},
      async getAgentInfo() {
        return { name: 'Creative boundary fixture', tools: tools.map(name => ({ name })) };
      },
      async getAdcpCapabilities(request) {
        capabilityAttempts++;
        if (preflightFailure && capabilityAttempts === 1) {
          throw new Error('Transient preflight capability failure');
        }
        requests.push({ task: 'get_adcp_capabilities', request });
        return { success: true, data: { ...discovery, context: request.context } };
      },
      async executeTask(task, request) {
        if (task === 'comply_test_controller') {
          if (request.scenario === 'force_upstream_unavailable') {
            unavailable = true;
            return { success: true, data: { success: true, context: request.context } };
          }
          assert.equal(request.scenario, 'query_upstream_traffic');
          trafficQueries.push(request);
          return { success: true, data: { success: true, attestation_mode: 'raw', recorded_calls: recordedCalls } };
        }
        assert.equal(task, 'build_creative');
        requests.push({ task, request });
        const form = request.evaluator.feature_agent ? 'feature_agent' : 'direct';
        if (form === 'feature_agent') {
          assert.equal(request.evaluator.agent_url, 'https://quality-evaluator.example/adcp');
          assert.equal(request.evaluator.evaluator_id, undefined, 'nested probe must not depend on an unprovisioned preset');
        }
        const url = request.evaluator.feature_agent?.agent_url ?? request.evaluator.agent_url;
        const offList = url === 'https://unaccepted-evaluator.example/adcp';
        recordedCalls = [];
        if (offList) {
          assert.equal(request.target_capability_id, expectedTarget);
          assert.deepEqual(request.creative_manifest, expectedManifest);
          if (testKit) assert.equal(request.message, undefined, 'operator source recipe must not acquire an unprovisioned brief');
          for (const key of ['rank_by', 'max_variants', 'keep_mode', 'variant_axis']) {
            assert.equal(request.evaluator[key] ?? request[key], undefined, `${key} is not a required probe precondition`);
          }
          assert.equal(request.evaluator.feature_agent?.feature_id, undefined);
          if (attack?.form === form && attack.endpoint) {
            recordedCalls.push({ timestamp: new Date().toISOString(), endpoint: attack.endpoint });
          }
          if (attack?.form === form && attack.accept) {
            return { success: true, data: successData(request.context) };
          }
          return { success: false, data: {
            errors: [{ code: attack?.form === form && attack.wrongCode ? 'INVALID_REQUEST' : 'EVALUATOR_AGENT_NOT_ACCEPTED', message: 'Off-list evaluator' }],
            context: request.context,
          } };
        }
        if (request.evaluator.ext?.api_key) {
          return { success: true, data: {
            errors: [{ code: 'CREDENTIAL_IN_ARGS', message: 'Credentials belong on transport' }],
            context: request.context,
          } };
        }
        if (optionalFailure) return { success: false, error: 'Optional accepted-evaluator probe failed' };
        const data = successData(request.context);
        if (unavailable) {
          data.errors = [{ code: 'INTERNAL_ERROR', message: 'Evaluator unavailable; seller-default ranking used' }];
        } else {
          recordedCalls = [{
            timestamp: new Date().toISOString(),
            endpoint: 'POST https://quality-evaluator.example/adcp',
            request_body: { creative_manifest: { assets: {} } },
          }];
        }
        return { success: true, data };
      },
    },
  });
  const [bundle] = buildComplianceBundleResults([{ ref: { kind: 'protocol', id: 'creative', path: '/fixture' }, storyboards: [storyboard] }], [result]);
  return { result, bundle, requests, trafficQueries, capabilityAttempts, steps: result.phases.flatMap(phase => phase.steps) };
}

test('supporting evaluator passes the complete authored boundary fixture with both rejection paths executed', async () => {
  const { result, steps, trafficQueries } = await runEvaluatorBoundary();
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.ok(steps.every(step => step.passed && !step.skipped), JSON.stringify(steps));
  for (const id of ['reject_unaccepted_agent_url', 'reject_unaccepted_feature_agent']) {
    const step = steps.find(step => step.step_id === id);
    assert.ok(step && step.passed && !step.skipped);
    for (const check of ['response_schema', 'error_code', 'upstream_traffic']) {
      assert.ok(step.validations.some(validation => validation.check === check && validation.passed && !validation.not_applicable), JSON.stringify(step));
    }
  }
  assert.equal(trafficQueries.length, 4, 'both rejections, credential probe and accepted invocation attest traffic');
});

for (const form of ['direct', 'feature_agent']) {
  for (const [label, attack, failingCheck] of [
    ['POST before correct rejection', { endpoint: 'POST https://unaccepted-evaluator.example/adcp' }, 'upstream_traffic'],
    ['GET discovery before correct rejection', { endpoint: 'GET https://unaccepted-evaluator.example/.well-known/oauth-protected-resource' }, 'upstream_traffic'],
    ['wrong acceptance without traffic', { accept: true }, 'error_code'],
    ['wrong rejection code', { wrongCode: true }, 'error_code'],
  ]) {
    test(`supporting evaluator fails aggregate for ${form} ${label}`, async () => {
      const { result, steps } = await runEvaluatorBoundary({ attack: { form, ...attack } });
      assert.equal(result.overall_passed, false, JSON.stringify(result));
      assert.equal(result.failed_count, 1, 'one violated rejection path must gate on its own');
      const id = form === 'direct' ? 'reject_unaccepted_agent_url' : 'reject_unaccepted_feature_agent';
      const step = steps.find(step => step.step_id === id);
      assert.ok(step && !step.passed && !step.skipped, JSON.stringify(step));
      assert.ok(step.validations.some(validation => validation.check === failingCheck && !validation.passed && !validation.not_applicable), JSON.stringify(step));
      if (form === 'feature_agent') {
        assert.ok(steps.some(step => step.step_id === 'reject_unaccepted_agent_url' && step.passed && !step.skipped), 'the passing direct probe must not rescue the nested failure');
      } else {
        assert.ok(steps.some(step => step.step_id === 'reject_unaccepted_feature_agent' && step.skip?.reason === 'prerequisite_failed'), 'the runner preserves its hard prerequisite cascade after a required failure');
      }
    });
  }
}

for (const support of [false, 'absent']) {
  test(`evaluator support ${support} skips before build or controller requirements`, async () => {
    const { result, requests, trafficQueries, steps } = await runEvaluatorBoundary({ support });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(result.failed_count, 0);
    assert.equal(result.passed_count, 0);
    assert.deepEqual(requests, []);
    assert.deepEqual(trafficQueries, []);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].skip_reason, 'capability_unsupported');
    assert.equal(steps[0].skip.reason, 'not_applicable');
  });
}

// Exercise actual SDK profiling, including its successful tool discovery plus
// transient get-capabilities failure. An explicit storyboard run must not infer
// evaluator support from an unknown profile, whatever the next response says.
for (const discoverySupport of [false, 'absent', true]) {
  test(`unknown preflight receives no evaluator coverage before later ${discoverySupport} discovery`, async () => {
    const { result, requests, trafficQueries, capabilityAttempts, steps } = await runEvaluatorBoundary({
      preflightFailure: true,
      discoverySupport,
    });
    assert.equal(capabilityAttempts, 1, 'normal profiling attempted capability discovery');
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(result.failed_count, 0);
    assert.equal(result.passed_count, 0, 'indeterminate applicability is not passing security coverage');
    assert.deepEqual(requests, []);
    assert.deepEqual(trafficQueries, []);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].skip.reason, 'not_applicable');
    assert.match(steps[0].skip.detail, /raw capabilities unavailable/);
  });
}

test('missing build catalog is a fixture gap with no false failure or security credit', async () => {
  const { result, requests, steps } = await runEvaluatorBoundary({ missingCatalog: 'build' });
  assert.equal(result.overall_passed, true);
  assert.equal(result.failed_count, 0);
  assert.equal(result.passed_count, 0);
  assert.match(result.coverage_gaps[0].detail, /creative_format:build/);
  assert.deepEqual(requests, []);
  assert.deepEqual(steps, []);
});

test('feature vocabulary is not a prerequisite for either required rejection probe', async () => {
  const { result, steps } = await runEvaluatorBoundary({ missingCatalog: 'feature' });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  for (const id of ['reject_unaccepted_agent_url', 'reject_unaccepted_feature_agent']) {
    const step = steps.find(step => step.step_id === id);
    assert.ok(step?.passed && !step.skipped, JSON.stringify(steps));
  }
});

test('supporting evaluator profile cannot skip required rejection by returning false in later discovery', async () => {
  for (const form of ['direct', 'feature_agent']) {
    const { result, steps } = await runEvaluatorBoundary({ discoverySupport: false, attack: { form, accept: true } });
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    assert.ok(steps.some(step => step.step_id === 'get_capabilities' && step.passed && !step.skipped), 'discovery alone passes the runner vacuous-pass guard');
    const id = form === 'direct' ? 'reject_unaccepted_agent_url' : 'reject_unaccepted_feature_agent';
    assert.ok(steps.some(step => step.step_id === id && !step.passed && !step.skipped), 'authoritative capability claim must keep rejection applicable');
  }
});

test('unrelated authored optional evaluator failure remains non-gating', async () => {
  const { result, steps } = await runEvaluatorBoundary({ optionalFailure: true });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.ok(steps.some(step => step.step_id === 'build_with_accepted_evaluator' && !step.passed && !step.skipped));
});


const completeImageRoute = id => ({ capability_id: id, operations: ['build'],
  format: { format_kind: 'image', params: {}, technical_requirements_complete: true } });
const previewFirstCatalog = () => [
  { capability_id: 'preview-only', operations: ['preview', 'validate'], format: { format_kind: 'image', params: {} } },
  completeImageRoute('actual-build'),
];
for (const form of ['direct', 'feature_agent']) {
  for (const attack of [undefined, { form, accept: true }, { form, wrongCode: true },
    { form, endpoint: 'GET https://unaccepted-evaluator.example/.well-known/oauth-protected-resource' }]) {
    test(`valid non-build-first catalog: ${form} ${JSON.stringify(attack ?? 'conformant')}`, async () => {
      const { result, requests } = await runEvaluatorBoundary({ catalog: previewFirstCatalog(), expectedTarget: 'actual-build', attack });
      assert.equal(result.overall_passed, !attack, JSON.stringify(result));
      assert.ok(requests.some(x => x.task === 'build_creative'));
      assert.equal(result.fixture_resolutions[0].seller_ids.capability_id, 'actual-build');
    });
  }
}
const sourceManifest = { format_kind: 'image', assets: { image_main: { asset_type: 'image',
  url: 'https://test-assets.example/source.jpg', width: 300, height: 250 } } };
const provisionedBuild = { creative_build_probes: [{
  match: [{ path: '/capability_id', operator: 'equals', value: 'transform-build' }],
  input: { creative_manifest: sourceManifest },
}] };
for (const form of ['direct', 'feature_agent']) {
  for (const malicious of [false, true]) {
    test(`matched source recipe skips unsatisfiable first build: ${form} malicious=${malicious}`, async () => {
      const { result } = await runEvaluatorBoundary({ generation: false, transformation: true,
        catalog: [completeImageRoute('requires-other-input'), completeImageRoute('transform-build')],
        testKit: provisionedBuild, expectedTarget: 'transform-build', expectedManifest: sourceManifest,
        attack: malicious ? { form, endpoint: 'POST https://unaccepted-evaluator.example/adcp' } : undefined });
      assert.equal(result.overall_passed, !malicious, JSON.stringify(result));
    });
  }
}
test('generation flag without complete input constraints gets no security coverage', async () => {
  const route = completeImageRoute('requires-seed'); delete route.format.technical_requirements_complete;
  const { result, requests } = await runEvaluatorBoundary({ catalog: [route] });
  assert.equal(result.failed_count, 0);
  assert.equal(result.passed_count, 0);
  assert.equal(result.coverage_gaps[0].reason, 'fixture_unsatisfied');
  assert.deepEqual(requests, []);
});
test('legacy omitted operations still resolves a targetable build route', async () => {
  const route = completeImageRoute('legacy-build'); delete route.operations;
  const { result } = await runEvaluatorBoundary({ catalog: [route], expectedTarget: 'legacy-build' });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
});

test('fresh payload-bound build authorization is an explicit fixture gap, not a guessed error precedence', async () => {
  const { result, requests } = await runEvaluatorBoundary({ governanceEnforcement: {
    tasks: [{ task: 'build_creative', modes: ['signed_context'] }],
  } });
  assert.equal(result.failed_count, 0);
  assert.equal(result.passed_count, 0);
  assert.match(result.coverage_gaps[0].detail, /payload-bound build governance authorization/);
  assert.deepEqual(requests, []);
});

test('real bundle grading withholds passing status for missing input and fails applicable attacks', async () => {
  const good = await runEvaluatorBoundary();
  assert.equal(good.result.overall_passed, true);
  assert.notEqual(good.bundle.status, 'failing'); // Existing optional advisory N/A evidence caps full-bundle coverage separately.
  assert.equal((await runEvaluatorBoundary({ missingCatalog: 'build' })).bundle.status, 'partial');
  const unsupported = await runEvaluatorBoundary({ support: false });
  assert.notEqual(unsupported.bundle.status, 'failing');
  assert.equal(unsupported.result.passed_count, 0);
  for (const form of ['direct', 'feature_agent']) {
    assert.equal((await runEvaluatorBoundary({ attack: { form, endpoint: 'POST https://unaccepted-evaluator.example/adcp' } })).bundle.status, 'failing');
    assert.equal((await runEvaluatorBoundary({ attack: { form, accept: true } })).bundle.status, 'failing');
  }
});
