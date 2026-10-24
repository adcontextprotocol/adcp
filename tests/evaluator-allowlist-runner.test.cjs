#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getComplianceStoryboardById } = require('@adcp/sdk/testing');
const { resolveDeclaredTestKit } = require(path.resolve(require.resolve('@adcp/sdk/testing'), '../storyboard/test-kit.js'));
const creativeScenariosPath = path.join(__dirname, '..', 'static', 'compliance', 'source', 'protocols', 'creative', 'scenarios');

// Use the complete authored fixture and the real loader/runner. In particular,
// the loader's name -> key context-output normalization and required capture
// failures must remain active; a hand-built phase cannot test applicability.
async function runEvaluatorBoundary({
  loadedStoryboard,
  support = true,
  discoverySupport = support,
  missingCatalog,
  attack,
  optionalFailure = false,
  preflightFailure = false,
  catalog,
  generation = true,
  transformation = false,
  transformers = false,
  expectedTransformer,
  expectedFormatId,
  adcpVersion,
  testKit,
  governanceEnforcement,
  capabilitiesVersion,
  schemaRoot,
  servedReleaseSchemaRoots,
  expectedTarget = 'display-build',
  expectedManifest = { format_kind: 'image', assets: {} },
  sdkApi,
  cachedCapabilityIssues,
} = {}) {
  const { parseStoryboard, runStoryboard, buildComplianceBundleResults, createTestClient, withExternalSchemaRoot, applyStoryboardVersionOptions } = sdkApi ?? require('@adcp/sdk/testing');
  const storyboard = loadedStoryboard ?? parseStoryboard(fs.readFileSync(path.join(creativeScenariosPath, 'evaluator_auth.yaml'), 'utf8'));
  const capabilities = {
    ...(capabilitiesVersion && { status: 'completed', adcp_version: capabilitiesVersion }),
    adcp: { major_versions: [3], ...(capabilitiesVersion && { supported_versions: [adcpVersion.split('.').slice(0, 2).join('.'), capabilitiesVersion] }), idempotency: { supported: false },
      ...(governanceEnforcement && { governance_enforcement: governanceEnforcement }) },
    supported_protocols: ['creative', 'governance'],
    creative: {
      ...(support !== undefined && { supports_evaluator: support }),
      supports_generation: generation,
      supports_transformation: transformation,
      supports_transformers: transformers,
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
  let runOptions = {
    _profile: preflightFailure ? undefined : { tools, raw_capabilities: capabilities,
      ...(cachedCapabilityIssues && { capabilities_schema_issues: cachedCapabilityIssues }) },
    _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic', 'force_upstream_unavailable'] },
    agentTools: preflightFailure ? undefined : tools,
    skip_controller_seeding: true,
    test_kit: testKit,
    adcpVersion,
    schemaRoot,
    servedReleaseSchemaRoots,
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
          assert.equal(request.target_capability_id, expectedTarget === null ? undefined : expectedTarget);
          assert.deepEqual(request.target_format_id, expectedFormatId);
          assert.deepEqual(request.creative_manifest, expectedManifest === null ? undefined : expectedManifest);
          assert.equal(request.transformer_id, expectedTransformer);
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
  };
  // Reproduce the runner's option resolution before creating a borrowed client:
  // declared kit auth must match, otherwise the SDK correctly replaces it.
  runOptions = resolveDeclaredTestKit(storyboard, applyStoryboardVersionOptions(storyboard, runOptions));
  if (adcpVersion) {
    // SDK14 ships prerelease3.2 bundles. Explicit stable roots must be active
    // when constructing the public client, just as the runner activates them
    // before it constructs an owned client. Do not waive the version guard.
    const create = () => createTestClient('https://agent.example/mcp', 'mcp', runOptions);
    const client = schemaRoot ? withExternalSchemaRoot(adcpVersion, schemaRoot, create) : create();
    runOptions._client = Object.assign(client, runOptions._client);
    runOptions._client.buildCreativeLegacy = input => runOptions._client.executeTask('build_creative', input);
  }
  const callerProfile = runOptions._profile;
  const profileBefore = callerProfile && structuredClone(callerProfile);
  const result = await runStoryboard('https://agent.example/mcp', storyboard, runOptions);
  if (callerProfile) assert.deepEqual(callerProfile, profileBefore, 'reused capability facts and discovery diagnostics remain caller-owned');
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

for (const mode of ['transformer', 'legacy']) {
  for (const attack of [undefined,
    { form: 'direct', endpoint: 'GET https://unaccepted-evaluator.example/probe' },
    { form: 'feature_agent', endpoint: 'POST https://unaccepted-evaluator.example/adcp' },
    { form: 'direct', accept: true }, { form: 'feature_agent', accept: true }]) {
    test(`authored fixture ${mode} provisioned input: ${attack ? JSON.stringify(attack) : 'good'}`, async () => {
      const legacy = mode === 'legacy';
      const legacyFormat = { agent_url: 'https://formats.example', id: 'sandbox_named_format' };
      const manifest = { format_kind: 'image', assets: { image_main: { asset_type: 'image', url: 'https://test-assets.example/image.jpg', width: 300, height: 250 } } };
      const input = legacy ? { creative_manifest: manifest, target_format_id: legacyFormat }
        : { transformer_id: 'sandbox-transformer', config: { headline: 'Winter offer' } };
      const entry = { ...(legacy ? {} : { capability_id: 'display-build', operations: ['build'] }), format: { format_kind: 'image', params: {} } };
      const opts = { attack, generation: false, transformation: legacy, transformers: !legacy,
        expectedTransformer: legacy ? undefined : input.transformer_id,
        expectedManifest: legacy ? manifest : null,
        expectedTarget: legacy ? null : 'display-build', expectedFormatId: legacy ? legacyFormat : undefined,
        adcpVersion: legacy ? '3.1.29' : undefined,
        catalog: legacy ? [{ format: { format_kind: 'video_vast', params: {} } }, entry] : [entry],
        testKit: { creative_build_probes: [{ match: [{ path: '/format/format_kind', operator: 'equals', value: 'image' }], input }] } };
      const { result } = await runEvaluatorBoundary(opts);
      assert.equal(result.overall_passed, !attack);
      assert.equal(result.failed_count, attack ? 1 : 0);
      assert.ok(result.passed_count > 0);
      assert.equal(result.fixture_resolutions[0].status, 'resolved');
      if (!attack) for (const id of ['payload_credentials_advisory', 'accepted_evaluator_invocation', 'accepted_evaluator_unavailable_degrades']) {
        const phase = result.phases.find(p => p.phase_id === id);
        assert.ok(phase.steps.some(step => !step.skipped), `${mode}: advisory phase ${id} must execute with either prepared selector`);
      }
    });
  }
}

test('full authored discovery still grades unrelated malformed metadata on an unsupported 3.1 kind', async () => {
  const target = { agent_url: 'https://formats.example', id: 'sandbox_named_format' };
  const { result } = await runEvaluatorBoundary({ adcpVersion: '3.1.29', generation: false, transformation: true,
    expectedTarget: null, expectedFormatId: target, expectedManifest: { format_kind: 'image', assets: {} },
    catalog: [{ format: { format_kind: 'future_canonical', params: {}, seller_preference: 123 } }, { format: { format_kind: 'image', params: {} } }],
    testKit: { creative_build_probes: [{ match: [{ path: '/format/format_kind', operator: 'equals', value: 'image' }], input: { creative_manifest: { format_kind: 'image', assets: {} }, target_format_id: target } }] }
  });
  assert.equal(result.overall_passed, false);
  const discovery = result.phases.flatMap(p => p.steps).find(step => step.step_id === 'get_capabilities');
  assert.equal(discovery.passed, false);
  assert.ok(discovery.validations.some(v => v.check === 'response_schema' && v.passed === false));
});


// Capability catalogs follow the validated served release; build inputs and
// dispatch remain on the selected run pin, including legacy named formats.
for (const attack of [undefined,
  { form: 'direct', endpoint: 'GET https://unaccepted-evaluator.example/discovery' },
  { form: 'feature_agent', endpoint: 'POST https://unaccepted-evaluator.example/adcp' },
  { form: 'direct', accept: true }, { form: 'feature_agent', accept: true }]) {
  test(`served 3.2 non-build-first catalog with pinned 3.1 input: ${JSON.stringify(attack ?? 'good')}`, async () => {
    const target = { agent_url: 'https://formats.example', id: 'sandbox_audio' };
    const manifest = { format_id: target, assets: {} };
    const { result, bundle, requests, steps } = await runEvaluatorBoundary({
      attack, adcpVersion: '3.1.29', capabilitiesVersion: '3.2',
      schemaRoot: path.resolve(__dirname, '../dist/schemas/3.1.29'),
      servedReleaseSchemaRoots: { '3.2.5': path.resolve(__dirname, '../dist/schemas/3.2.5') },
      generation: false, transformation: true,
      catalog: [
        { capability_id: 'validate-only', operations: ['validate'], format: { format_kind: 'audio_vast', params: {} } },
        { capability_id: 'audio-build', operations: ['build'], format: { format_kind: 'audio_vast', params: {}, v1_format_ref: [target] } },
      ],
      expectedTarget: null, expectedFormatId: target, expectedManifest: manifest,
      testKit: { creative_build_probes: [{
        match: [{ path: '/capability_id', operator: 'equals', value: 'audio-build' }],
        input: { creative_manifest: manifest, target_format_id: target },
      }] },
    });
    assert.equal(result.overall_passed, !attack, JSON.stringify(result));
    assert.equal(result.fixture_resolutions[0].status, 'resolved');
    assert.ok(requests.some(({ task, request }) => task === 'build_creative' && request.target_format_id?.id === target.id));
    assert.ok(steps.find(step => step.step_id === 'get_capabilities').validations.some(v => v.check === 'response_schema' && v.passed));
    if (attack) assert.equal(bundle.status, 'failing');
    else for (const id of ['reject_unaccepted_agent_url', 'reject_unaccepted_feature_agent']) {
      const step = steps.find(step => step.step_id === id);
      assert.ok(step.passed && !step.skipped);
      assert.ok(step.validations.some(v => v.check === 'upstream_traffic' && v.passed && !v.not_applicable));
    }
  });
}

// Both released catalog item schemas explicitly allow entry extensions. A
// provisioned recipe can supply valid input when automatic preparation cannot
// interpret an extension; do not turn that valid catalog into a producer fault.
test('served 3.2 catalog retains legal entry extensions with provisioned input', async () => {
  const { result, steps } = await runEvaluatorBoundary({
    adcpVersion: '3.2.5', capabilitiesVersion: '3.2', generation: false, transformation: true,
    schemaRoot: path.resolve(__dirname, '../dist/schemas/3.2.5'),
    catalog: [{ ...completeImageRoute('transform-build'), seller_extension: { workflow: 'sandbox' } }],
    testKit: provisionedBuild, expectedTarget: 'transform-build', expectedManifest: sourceManifest,
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.fixture_resolutions[0].status, 'resolved');
  assert.ok(steps.find(step => step.step_id === 'get_capabilities').validations.some(v => v.check === 'response_schema' && v.passed));
  for (const id of ['reject_unaccepted_agent_url', 'reject_unaccepted_feature_agent']) {
    assert.ok(steps.some(step => step.step_id === id && step.passed && !step.skipped));
  }
});

// Canonical CI shards run this suite in a fresh checkout independently of the
// build job. Build the mutable candidate bundle before exercising its loader;
// immutable release bundles remain untouched.
test.before(() => {
  require('node:child_process').execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/build-compliance.cjs')], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit', maxBuffer: 16 * 1024 * 1024,
  });
});

for (const [label, options] of [
  ['supporting-good', {}],
  ['direct-outbound', { attack: { form: 'direct', endpoint: 'GET https://unaccepted-evaluator.example/probe' } }],
  ['nested-acceptance', { attack: { form: 'feature_agent', accept: true } }],
  ['unsupported', { support: false }],
  ['unknown', { support: 'absent' }],
]) {
  test(`actual maintenance bundle loads and grades ${label} on the locked SDK`, async () => {
    const loadedStoryboard = getComplianceStoryboardById('creative/evaluator_auth', {
      complianceDir: path.resolve(__dirname, '../dist/compliance/latest'),
    });
    assert.ok(loadedStoryboard?.creative_build_probe, 'built bundle must retain the authored preparation contract');
    const { result, bundle, requests, steps } = await runEvaluatorBoundary({
      ...options, loadedStoryboard, adcpVersion: '3.2.5', capabilitiesVersion: '3.2',
      schemaRoot: path.resolve(__dirname, '../dist/schemas/3.2.5'),
    });
    if (options.attack) {
      assert.equal(bundle.status, 'failing');
      const id = options.attack.form === 'direct' ? 'reject_unaccepted_agent_url' : 'reject_unaccepted_feature_agent';
      const boundary = steps.find(step => step.step_id === id);
      assert.ok(boundary && !boundary.skipped && !boundary.passed, 'the actual applicable boundary must fail');
      assert.ok(boundary.validations.some(v => !v.passed && v.check === (options.attack.accept ? 'error_code' : 'upstream_traffic')));
    }
    else if (options.support === false || options.support === 'absent') {
      assert.equal(result.failed_count, 0); assert.equal(result.passed_count, 0);
      assert.ok(!requests.some(request => request.task === 'build_creative'));
    } else assert.equal(result.overall_passed, true, JSON.stringify(result));
  });
}

for (const [label, attack] of [
  ['supporting-good', undefined],
  ['direct-outbound', { form: 'direct', endpoint: 'POST https://unaccepted-evaluator.example/probe' }],
  ['feature-outbound', { form: 'feature_agent', endpoint: 'GET https://unaccepted-evaluator.example/probe' }],
  ['direct-wrong-acceptance', { form: 'direct', accept: true }],
  ['feature-wrong-acceptance', { form: 'feature_agent', accept: true }],
]) {
 for (const mode of ['cjs', 'esm']) {
  test(`actual ${mode} opted bundle uses builtin RC JSON authority despite stale generated Zod: ${label}`, async () => {
    const sdkApi = mode === 'esm' ? await import('@adcp/sdk/testing') : require('@adcp/sdk/testing');
    const loadedStoryboard = sdkApi.getComplianceStoryboardById('creative/evaluator_auth', {
      complianceDir: path.resolve(__dirname, '../dist/compliance/latest'),
    });
    const { result, bundle, steps } = await runEvaluatorBoundary({
      sdkApi, loadedStoryboard, attack, adcpVersion: '3.2.5', capabilitiesVersion: '3.2-rc.7',
      schemaRoot: path.resolve(__dirname, '../dist/schemas/3.2.5'),
      governanceEnforcement: { tasks: [{ task: 'create_media_buy', modes: ['signed_context', 'online_execution_check'] }] },
      cachedCapabilityIssues: [{ pointer: '/adcp/governance_enforcement', message: 'Prior discovery schema authority was not recorded' }],
    });
    const discovery = steps.find(step => step.step_id === 'get_capabilities');
    const schema = discovery.validations.find(validation => validation.check === 'response_schema');
    assert.equal(schema.passed, true);
    assert.equal(schema.strict.valid, true);
    assert.equal(schema.strict.lenient_valid, false);
    assert.match(schema.warning, /JSON schema.*generated Zod/);
    assert.ok(result.notices.some(notice => notice.code === 'capabilities_response_schema_invalid'
      && notice.message.includes('Cached capability-discovery diagnostic (not this run\'s response_schema verdict)')));
    if (attack) {
      assert.equal(bundle.status, 'failing');
      const id = attack.form === 'direct' ? 'reject_unaccepted_agent_url' : 'reject_unaccepted_feature_agent';
      assert.ok(steps.some(step => step.step_id === id && !step.passed && !step.skipped));
    } else assert.equal(result.overall_passed, true, JSON.stringify(result));
  });
 }
}
