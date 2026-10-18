// Maintenance integration regressions adapted from merged adcp-client#3332.
// Run against this branch's actual, unchanged SDK dependency.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTestClient, parseStoryboard, runStoryboard, runStoryboardStep, withExternalSchemaRoot, buildComplianceBundleResults } = require('@adcp/sdk/testing');

const schemaData = path.join(__dirname, '../dist/schemas');
const named = { agent_url: 'https://formats.example', id: 'sandbox_audio' };
let temporaryRoot;
let hostedRoot;
before(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-probe-authority-'));
  hostedRoot = path.join(temporaryRoot, 'hosted-3.2');
  fs.cpSync(path.join(schemaData, '3.2.5'), hostedRoot, { recursive: true });
  // A catalog root must never become the source-manifest authority. Poison
  // its manifest validator while retaining a valid pinned 3.1 manifest.
  const file = path.join(hostedRoot, 'core/creative-manifest.json');
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  schema.not = {};
  fs.writeFileSync(file, JSON.stringify(schema));
});
after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

function storyboard() {
  return parseStoryboard(`
id: evaluator_served_catalog
version: "1.0.0"
title: Served evaluator catalog
category: creative
summary: Served catalog with pinned build inputs
creative_build_probe:
  context_prefix: build
  message: Build a sandbox creative
phases:
${['direct', 'nested']
  .map(
    form => `
  - id: ${form}
    title: ${form}
    steps:
      - id: reject_${form}
        title: Reject ${form}
        task: build_creative
        requires_contract: creative_build_probe_runner
        stateful: true
        expect_error: true
        sample_request:
          evaluator:
            agent_url: "https://${form === 'direct' ? 'off-list' : 'accepted'}.example/adcp"
${form === 'nested' ? '            feature_agent:\n              agent_url: "https://off-list.example/adcp"' : ''}
        context_inputs:
          - key: build_capability_id
            inject_at: target_capability_id
          - key: build_target_format_id
            inject_at: target_format_id
          - key: build_creative_manifest
            inject_at: creative_manifest
        validations:
          - check: error_code
            value: EVALUATOR_AGENT_NOT_ACCEPTED
          - check: upstream_traffic
            min_count: 0
            endpoint_pattern: "* https://off-list.example/*"
`
  )
  .join('')}`);
}

async function run({
  standalone = false,
  form = 'direct',
  attack,
  echo = '3.2',
  supported = ['3.1', '3.2'],
  pin = '3.1.29',
  entries,
  target = named,
  manifest,
  generation = false,
  recipes = true,
  servedRoot = hostedRoot,
} = {}) {
  const calls = [];
  let recorded = [];
  const tools = ['get_adcp_capabilities', 'build_creative', 'comply_test_controller'];
  const creative = {
    supports_evaluator: true,
    supports_generation: generation,
    supports_transformation: true,
    supported_formats: entries ?? [
      {
        capability_id: 'audio-build',
        operations: ['build'],
        format: { format_kind: 'audio_vast', params: {}, v1_format_ref: [target] },
      },
    ],
  };
  const inputManifest = manifest ?? { format_id: named, assets: {} };
  const caps = {
    ...(echo !== null && { adcp_version: echo }),
    adcp: { major_versions: [3], supported_versions: supported },
    creative,
  };
  const opts = {
    adcpVersion: pin,
    ...(pin.includes('-') ? {} : { schemaRoot: path.join(schemaData, pin.startsWith('3.1') ? '3.1.29' : '3.2.5') }),
    servedReleaseSchemaRoots: { '3.2.5': servedRoot },
    _profile: { tools, raw_capabilities: caps },
    agentTools: tools,
    _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
    test_kit: recipes
      ? {
          creative_build_probes: [
            {
              match: [
                {
                  path: '/format/format_kind',
                  operator: 'equals',
                  value: entries?.[0]?.format.format_kind ?? 'audio_vast',
                },
              ],
              input: { target_format_id: target, creative_manifest: inputManifest },
            },
          ],
        }
      : undefined,
  };
  const create = () => createTestClient('https://agent.example/mcp', 'mcp', opts);
  const client = opts.schemaRoot ? withExternalSchemaRoot(pin, opts.schemaRoot, create) : create();
  client.resetContext = () => {};
  client.executeTask = async (task, request) => {
    if (task === 'comply_test_controller')
      return { success: true, data: { success: true, attestation_mode: 'raw', recorded_calls: recorded } };
    assert.equal(task, 'build_creative');
    assert.equal(request.target_capability_id, undefined, 'legacy request must retain its provisioned selector');
    assert.deepEqual(request.target_format_id, target);
    assert.deepEqual(request.creative_manifest, inputManifest, 'served catalog must not rewrite pinned source input');
    calls.push(request);
    const currentForm = request.evaluator.feature_agent ? 'nested' : 'direct';
    recorded =
      currentForm === form && attack === 'outbound'
        ? [{ timestamp: new Date().toISOString(), endpoint: 'GET https://off-list.example/probe' }]
        : [];
    if (currentForm === form && attack === 'accept') return { success: true, data: { creatives: [] } };
    return { success: false, data: { errors: [{ code: 'EVALUATOR_AGENT_NOT_ACCEPTED', message: 'Rejected' }] } };
  };
  client.buildCreativeLegacy = request => client.executeTask('build_creative', request);
  opts._client = client;
  const result = standalone
    ? await runStoryboardStep('https://agent.example/mcp', storyboard(), `reject_${form}`, opts)
    : await runStoryboard('https://agent.example/mcp', storyboard(), opts);
  return { result, calls, caps };
}

for (const standalone of [false, true]) {
  for (const legacyRatio of [undefined, 3]) {
    for (const form of ['direct', 'nested']) {
      for (const [attack, expectedPassed] of [
        [undefined, true],
        ['outbound', false],
        ['accept', false],
      ]) {
        test(`provisioned 2x target respects old unspecified parameters: standalone=${standalone}, oldRatio=${legacyRatio}, ${form}, ${attack ?? 'good'}`, async () => {
          const target = {
            agent_url: 'https://formats.example',
            id: 'display_image',
            width: 300,
            height: 250,
            pixel_ratio: 2,
          };
          const legacyRef = {
            agent_url: target.agent_url,
            id: target.id,
            width: 300,
            height: 250,
            ...(legacyRatio !== undefined && { pixel_ratio: legacyRatio }),
          };
          const { result, calls } = await run({
            standalone,
            form,
            attack,
            pin: '3.2.5',
            echo: '3.1',
            target,
            manifest: {
              format_kind: 'image',
              assets: {
                image_main: {
                  asset_type: 'image',
                  url: 'https://test-assets.example/source-2x.jpg',
                  width: 600,
                  height: 500,
                  pixel_ratio: 2,
                },
              },
            },
            entries: [
              {
                capability_id: 'seller.route:density',
                format: { format_kind: 'image', params: {}, v1_format_ref: [legacyRef] },
              },
            ],
          });
          assert.equal(standalone ? result.passed : result.overall_passed, expectedPassed, JSON.stringify(result));
          assert.ok(calls.length > 0, 'the provisioned 2x boundary must execute');
          if (!standalone) assert.equal(result.fixture_resolutions[0].status, 'resolved');
          if (attack) {
            const step = standalone
              ? result
              : result.phases.flatMap(phase => phase.steps).find(step => step.step_id === `reject_${form}`);
            assert.ok(
              step.validations.some(
                validation =>
                  validation.check === (attack === 'outbound' ? 'upstream_traffic' : 'error_code') &&
                  validation.passed === false
              )
            );
          }
        });
      }
    }
  }
  for (const form of ['direct', 'nested']) {
    for (const attack of [undefined, 'outbound', 'accept']) {
      test(`served 3.2 audio catalog with pinned 3.1 input: standalone=${standalone}, ${form}, ${attack ?? 'good'}`, async () => {
        const { result, calls } = await run({ standalone, form, attack });
        assert.equal(standalone ? result.passed : result.overall_passed, !attack, JSON.stringify(result));
        assert.ok(calls.length > 0, 'the boundary must execute rather than award unavailable coverage');
        if (attack) {
          const step = standalone
            ? result
            : result.phases.flatMap(phase => phase.steps).find(step => step.step_id === `reject_${form}`);
          assert.ok(
            step.validations.some(
              validation =>
                validation.check === (attack === 'outbound' ? 'upstream_traffic' : 'error_code') && !validation.passed
            )
          );
        }
      });
    }
  }
  for (const [label, echo, supported] of [
    ['missing echo', null, ['3.1', '3.2']],
    ['patch precision is not a valid echo', '3.2.5', ['3.2.5']],
    ['different major', '4.0', ['4.0']],
    ['unlisted release', '3.2', ['3.1']],
    ['unavailable release root', '3.9', ['3.9']],
  ]) {
    test(`catalog echo guard preserves pinned authority: standalone=${standalone}, ${label}`, async () => {
      const { result, calls } = await run({ standalone, echo, supported });
      assert.deepEqual(calls, []);
      if (standalone) assert.equal(result.skip_reason, 'fixture_unsatisfied');
      else {
        assert.equal(result.failed_count, 0);
        assert.equal(result.passed_count, 0);
        assert.match(result.coverage_gaps[0].detail, /3\.1\.29.*audio_vast/);
      }
    });
  }
  test(`served density is enforced even when request pin treats pixel_ratio as opaque: ${standalone}`, async () => {
    const id = { ...named, width: 300, height: 250, pixel_ratio: 2 };
    const { result, calls } = await run({ standalone, target: id });
    assert.deepEqual(calls, []);
    assert.equal(standalone ? result.skip_reason : result.coverage_gaps[0].reason, 'fixture_unsatisfied');
  });
  test(`old served identifiers and operations retain old meaning under a newer request: ${standalone}`, async () => {
    const { result, calls } = await run({
      standalone,
      pin: '3.2.5',
      echo: '3.1',
      supported: ['3.1', '3.2'],
      manifest: { format_kind: 'image', assets: {} },
      entries: [
        {
          capability_id: 'seller.route:with-dots',
          operations: ['preview'],
          format: { format_kind: 'image', params: {} },
        },
      ],
    });
    assert.ok(calls.length > 0);
    assert.equal(standalone ? result.passed : result.overall_passed, true, JSON.stringify(result));
  });
  test(`a newer request cannot infer canonical addressing from old catalog extensions: ${standalone}`, async () => {
    const { result, calls } = await run({
      standalone,
      pin: '3.2.5',
      echo: '3.1',
      generation: true,
      recipes: false,
      entries: [
        {
          capability_id: 'legacy-build',
          format: { format_kind: 'image', params: {}, technical_requirements_complete: true },
        },
      ],
    });
    assert.deepEqual(calls, []);
    if (standalone) assert.equal(result.skip_reason, 'fixture_unsatisfied');
    else {
      assert.equal(result.failed_count, 0);
      assert.equal(result.passed_count, 0);
      assert.equal(result.coverage_gaps[0].reason, 'fixture_unsatisfied');
    }
  });
  test(`served canonical ID uniqueness applies even under an old request pin: ${standalone}`, async () => {
    const entry = {
      capability_id: 'audio-build',
      operations: ['build'],
      format: { format_kind: 'audio_vast', params: {}, v1_format_ref: [named] },
    };
    const { result, calls } = await run({ standalone, entries: [entry, structuredClone(entry)] });
    assert.deepEqual(calls, []);
    if (standalone) assert.equal(result.passed, false);
    else assert.equal(result.failed_count, 1);
    const step = standalone
      ? result
      : result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'creative_build_catalog');
    assert.match(step.validations[0].error, /unique/);
  });
  test(`a served-valid canonical audio manifest cannot replace pinned legacy input validation: ${standalone}`, async () => {
    await assert.rejects(
      run({
        standalone,
        manifest: { format_kind: 'audio_vast', assets: {} },
        servedRoot: path.join(schemaData, '3.2.5'),
      }),
      /creative_manifest must be a complete manifest/
    );
  });
  test(`a served canonical catalog does not inherit the pinned legacy open enum: ${standalone}`, async () => {
    const { result, calls } = await run({
      standalone,
      entries: [
        { capability_id: 'future', operations: ['build'], format: { format_kind: 'future_canonical', params: {} } },
      ],
    });
    assert.deepEqual(calls, []);
    if (standalone) assert.equal(result.passed, false);
    else assert.equal(result.failed_count, 1);
    const step = standalone
      ? result
      : result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'creative_build_catalog');
    assert.equal(step.validations[0].check, 'creative_build_probe_catalog');
    assert.equal(step.validations[0].passed, false);
  });
  test(`an invalid supplied served root is rejected before dispatch: ${standalone}`, async () => {
    await assert.rejects(run({ standalone, servedRoot: path.join(temporaryRoot, 'missing') }), /root|schema|ENOENT/);
  });
}

const sdkRoot = path.resolve(require.resolve('@adcp/sdk/testing'), '../../../..');
const schemaLoader = require(path.join(sdkRoot, 'dist/lib/validation/schema-loader.js'));
const runtimePin = require('@adcp/sdk').ADCP_VERSION;

test('the actual RC pin selects a listed stable catalog only when its schema is available', () => {
  assert.match(runtimePin, /-rc\./);
  assert.doesNotThrow(() => schemaLoader.toReleasePrecisionWire(runtimePin));
  assert.equal(schemaLoader.hasSchemaBundle('3.2'), false, 'the pinned SDK does not ship stable3.2');
  const caps = { adcp_version: '3.2', adcp: { supported_versions: ['3.2'] } };
  assert.equal(schemaLoader.withServedValidationVersion(caps, runtimePin, version => version), runtimePin);
  const selected = schemaLoader.withServedReleaseSchemaRoots({ '3.2.5': path.join(schemaData, '3.2.5') }, () =>
    schemaLoader.withServedValidationVersion(caps, runtimePin, version => version));
  assert.equal(selected, '3.2');
  assert.equal(schemaLoader.hasSchemaBundle('3.2'), false, 'the catalog root must not escape its scope');
});

for (const standalone of [false, true]) {
  for (const variant of ['dotted-id', 'duplicate-id', 'undefined-operations-extension']) {
    test(`RC request pin respects served3.1 catalog rules: ${standalone}, ${variant}`, async () => {
      const target = { agent_url: 'https://formats.example', id: 'sandbox_image', width: 300, height: 250 };
      const entry = {
        capability_id: 'seller.route:with-dots',
        format: { format_kind: 'image', params: {}, v1_format_ref: [target] },
        ...(variant === 'undefined-operations-extension' ? { operations: ['render'] } : {}),
      };
      const { result, calls } = await run({
        standalone, pin: runtimePin, echo: '3.1', target,
        entries: variant === 'duplicate-id' ? [entry, structuredClone(entry)] : [entry],
        manifest: { format_kind: 'image', assets: { image_main: {
          asset_type: 'image', url: 'https://test-assets.example/source.jpg', width: 300, height: 250,
        } } },
      });
      assert.equal(standalone ? result.passed : result.overall_passed, true, JSON.stringify(result));
      assert.ok(calls.length > 0, 'an applicable valid probe must actually execute');
    });
  }
}

test('served3.0 lacks a build-catalog contract and receives a zero-credit fixture gap', async () => {
  const { result, calls } = await run({ pin: runtimePin, echo: '3.0', supported: ['3.0', '3.2'] });
  assert.equal(calls.length, 0);
  // The raw overall_passed flag does not certify fixture coverage. Assert
  // the public bundle's aggregate result and executed credit explicitly.
  const [bundle] = buildComplianceBundleResults([{ ref: { kind: 'protocol', id: 'creative', path: '/fixture' }, storyboards: [storyboard()] }], [result]);
  assert.equal(bundle.status, 'partial');
  assert.equal(result.passed_count, 0);
  assert.equal(result.fixture_resolutions[0].status, 'unsatisfied');
  assert.equal(result.failed_count, 0, 'missing catalog authority is a fixture gap, not a producer verdict');
});

test('non-opted no-echo, unlisted and unavailable-root response validation stays identical to stockSDK14', () => {
  const { createHash } = require('node:crypto');
  const bridgeManifest = require('../patches/sdk-creative-build-probe/manifest.json');
  const parent = path.join(__dirname, '../.context');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'sdk14-authority-baseline-'));
  const stock = path.join(dir, 'node_modules/@adcp/sdk');
  try {
    fs.cpSync(sdkRoot, stock, { recursive: true });
    for (const entry of bridgeManifest.files) {
      const file = path.join(stock, entry.path);
      if (entry.before === null) { fs.rmSync(file); continue; }
      let text = fs.readFileSync(file, 'utf8');
      assert.equal(createHash('sha256').update(text).digest('hex'), entry.after);
      for (const edit of [...entry.replacements].reverse()) text = text.replace(edit.to, () => edit.from);
      assert.equal(createHash('sha256').update(text).digest('hex'), entry.before);
      fs.writeFileSync(file, text);
    }
    const original = require(path.join(stock, 'dist/lib/testing/storyboard/validations.js'));
    const patched = require(path.join(sdkRoot, 'dist/lib/testing/storyboard/validations.js'));
    for (const [echo, supported] of [[undefined, ['3.1']], ['3.1', ['3.2']], ['3.9', ['3.9']]]) {
      const context = {
        taskName: 'get_adcp_capabilities', adcpVersion: runtimePin,
        responseSchemaRef: 'protocol/get-adcp-capabilities-response.json',
        taskResult: { success: true, data: {
          ...(echo && { adcp_version: echo }), adcp: { major_versions: [3], supported_versions: supported },
          supported_protocols: ['creative'], creative: { supports_evaluator: false },
        } },
      };
      const validations = [{ check: 'response_schema', description: 'Stock authority control' }];
      assert.deepEqual(patched.runValidations(validations, structuredClone(context)),
        original.runValidations(validations, structuredClone(context)), `echo=${echo}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RC selection ignores unlisted, cross-major, semver and malformed echoes even with a stable root available', () => {
  schemaLoader.withServedReleaseSchemaRoots({ '3.2.5': path.join(schemaData, '3.2.5') }, () => {
    for (const echo of ['4.0', '9.9', 'latest', '../../etc', '3.2-..', '3.1.29']) {
      const response = { adcp_version: echo, adcp: { supported_versions: [echo] } };
      assert.equal(schemaLoader.withServedValidationVersion(response, runtimePin, version => version), runtimePin, echo);
    }
    const response = { adcp_version: '3.2', adcp: { supported_versions: ['3.1'] } };
    assert.equal(schemaLoader.withServedValidationVersion(response, runtimePin, version => version), runtimePin);
  });
});

test('validators are root-qualified and a served root never replaces the pinned manifest authority', () => {
  const alternate = path.join(temporaryRoot, 'poisoned-3.1');
  fs.cpSync(path.join(schemaData, '3.1.29'), alternate, { recursive: true });
  const file = path.join(alternate, 'core/creative-manifest.json');
  const schema = JSON.parse(fs.readFileSync(file, 'utf8')); schema.not = {};
  fs.writeFileSync(file, JSON.stringify(schema));
  withExternalSchemaRoot('3.1.29', path.join(schemaData, '3.1.29'), () => {
    const pinned = schemaLoader.getSchemaValidatorByRef('core/creative-manifest.json', '3.1.29');
    const input = { format_id: named, assets: {} };
    assert.equal(pinned(input), true);
    schemaLoader.withServedReleaseSchemaRoots({ '3.1.29': alternate }, () => {
      const response = { adcp_version: '3.1', adcp: { supported_versions: ['3.1'] } };
      schemaLoader.withServedValidationVersion(response, runtimePin, selected => {
        const served = schemaLoader.getSchemaValidatorByRef('core/creative-manifest.json', selected);
        assert.notEqual(served, pinned);
        assert.equal(served(input), false);
        assert.equal(pinned(input), true, 'already captured request validator stays pinned');
      });
    });
    assert.equal(schemaLoader.getSchemaValidatorByRef('core/creative-manifest.json', '3.1.29'), pinned);
  });
});
