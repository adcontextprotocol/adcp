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

function governanceCatalog() {
  return {
    status: 'completed', adcp_version: '3.2-rc.7',
    adcp: {
      major_versions: [3], supported_versions: ['3.2-rc.7', '3.2'], idempotency: { supported: false },
      governance_enforcement: { tasks: [
        { task: 'buy_products', modes: ['signed_context'] },
        { task: 'accept_proposal', modes: ['signed_context'] },
        { task: 'control_media_buy', modes: ['signed_context'] },
        { task: 'create_media_buy', modes: ['signed_context', 'online_execution_check'] },
      ] },
    },
    supported_protocols: ['media_buy'], experimental_features: ['governance.campaign'],
  };
}

function reconstructStock(t) {
  const { createHash } = require('node:crypto');
  const manifest = require('../patches/sdk-creative-build-probe/manifest.json');
  const dir = fs.mkdtempSync(path.join(__dirname, '../.context/sdk14-scoped-stock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stock = path.join(dir, 'node_modules/@adcp/sdk');
  fs.cpSync(sdkRoot, stock, { recursive: true });
  for (const entry of manifest.files) {
    const file = path.join(stock, entry.path);
    if (entry.before === null) { fs.rmSync(file); continue; }
    let text = fs.readFileSync(file, 'utf8');
    assert.equal(createHash('sha256').update(text).digest('hex'), entry.after);
    for (const edit of [...entry.replacements].reverse()) {
      assert.equal(text.split(edit.to).length - 1, 1);
      text = text.replace(edit.to, () => edit.from);
    }
    assert.equal(createHash('sha256').update(text).digest('hex'), entry.before);
    fs.writeFileSync(file, text);
  }
  return stock;
}

// This parent compiles both real module systems and a reconstructed stock SDK;
// child assertions remain bounded and the process must exit naturally.
test('paired authority scope preserves stock14 and distinguishes actual JSON from generated Zod in CJS/ESM', { timeout: 90000 }, async t => {
  const stock = reconstructStock(t);
  const { pathToFileURL } = require('node:url');
  for (const ext of ['js', 'mjs']) {
    const load = file => ext === 'js' ? require(file) : import(pathToFileURL(file).href);
    const loader = await load(path.join(sdkRoot, `dist/lib/validation/schema-loader.${ext}`));
    const validations = await load(path.join(sdkRoot, `dist/lib/testing/storyboard/validations.${ext}`));
    const originalLoader = await load(path.join(stock, `dist/lib/validation/schema-loader.${ext}`));
    const originalValidations = await load(path.join(stock, `dist/lib/testing/storyboard/validations.${ext}`));
    const clientModule = await load(path.join(sdkRoot, `dist/lib/testing/client.${ext}`));
    const originalClientModule = await load(path.join(stock, `dist/lib/testing/client.${ext}`));
    const check = (module, data = governanceCatalog(), extra = {}) => module.runValidations(
      [{ check: 'response_schema', description: 'Capability catalog' }], {
        taskName: 'get_adcp_capabilities', adcpVersion: '3.2.5',
        responseSchemaRef: 'protocol/get-adcp-capabilities-response.json',
        taskResult: { success: true, data }, ...extra,
      },
    )[0];
    const source = fn => loader.withExternalSchemaRoot('3.2.5', path.join(schemaData, '3.2.5'), fn);
    const stockSource = fn => originalLoader.withExternalSchemaRoot('3.2.5', path.join(schemaData, '3.2.5'), fn);

    await t.test(`${ext}: non-opted RC/source-root mismatch exactly matches real stock14`, () => {
      assert.deepEqual(source(() => check(validations)), stockSource(() => check(originalValidations)));
      assert.equal(source(() => check(validations)).passed, true);
      assert.equal(loader.isCreativeBuildProbeSchemaScopeActive(), false);
    });
    await t.test(`${ext}: opted builtin JSON-valid catalog survives stale Zod with truthful warning`, () => {
      const result = source(() => loader.withCreativeBuildProbeSchemaScope(true, () => check(validations)));
      assert.equal(result.passed, true);
      assert.equal(result.strict.valid, true);
      assert.equal(result.strict.lenient_valid, false);
      assert.match(result.schema_url, /3\.2-rc\.7/);
      assert.match(result.warning, /JSON schema.*generated Zod/);
    });
    await t.test(`${ext}: implicit SDK request pin uses the same served selection as the probe helper`, () => {
      const data = governanceCatalog(); data.adcp_version = '3.1'; data.adcp.supported_versions = ['3.1', '3.2-rc.7'];
      data.adcp.governance_enforcement.tasks = [{ task: 'create_media_buy', modes: ['online_execution_check'] }];
      const result = loader.withCreativeBuildProbeSchemaScope(true, () => check(validations, data, {
        adcpVersion: undefined, responseAdcpVersion: '3.2.0-rc.7',
      }));
      assert.match(result.schema_url, /schemas\/3\.1\//);
      assert.equal(result.strict.valid, true);
      assert.equal(result.passed, true);
    });
    await t.test(`${ext}: external served JSON is authoritative and actual JSON-invalid stays failed`, () => {
      const poisoned = path.join(temporaryRoot, `invalid-capabilities-${ext}`);
      fs.cpSync(path.join(schemaData, '3.2.5'), poisoned, { recursive: true });
      const file = path.join(poisoned, 'protocol/get-adcp-capabilities-response.json');
      const document = JSON.parse(fs.readFileSync(file, 'utf8')); document.not = {};
      fs.writeFileSync(file, JSON.stringify(document));
      // This owned root uses raw JSON rather than its precompiled bundle, whose
      // independent snapshot would otherwise correctly retain the old schema.
      fs.rmSync(path.join(poisoned, 'bundled'), { recursive: true, force: true });
      const data = governanceCatalog(); data.adcp_version = '3.2';
      data.adcp.governance_enforcement.tasks[3].modes = ['signed_context'];
      const result = loader.withCreativeBuildProbeSchemaScope(true, () =>
        loader.withServedReleaseSchemaRoots({ '3.2.5': poisoned }, () => check(validations, data, { adcpVersion: runtimePin })),
      );
      assert.equal(result.passed, false);
      assert.equal(result.strict.valid, false);
      assert.equal(result.strict.lenient_valid, true, 'actual JSON rejection must override generated-Zod acceptance');
      assert.match(result.schema_url, /schemas\/3\.2\//);
      assert.ok(result.actual.some(issue => issue.keyword === 'not'));
    });
    await t.test(`${ext}: actual builtin JSON-invalid catalog cannot receive passing credit`, () => {
      const data = governanceCatalog(); data.adcp.idempotency = { supported: true, replay_ttl_seconds: 1 };
      const result = loader.withCreativeBuildProbeSchemaScope(true, () => check(validations, data));
      assert.equal(result.passed, false);
      assert.equal(result.strict.valid, false);
      assert.ok(result.actual.length > 0);
    });
    await t.test(`${ext}: absent strict schema is a failing harness diagnostic, never pass/skip`, () => {
      const missing = path.join(temporaryRoot, `missing-capabilities-${ext}`);
      fs.cpSync(path.join(schemaData, '3.2.5'), missing, { recursive: true });
      fs.rmSync(path.join(missing, 'bundled'), { recursive: true, force: true });
      fs.rmSync(path.join(missing, 'protocol/get-adcp-capabilities-response.json'));
      const data = governanceCatalog(); data.adcp_version = '3.2';
      const result = loader.withExternalSchemaRoot('3.2.5', missing, () =>
        loader.withCreativeBuildProbeSchemaScope(true, () => check(validations, data)));
      assert.equal(result.passed, false);
      assert.equal(result.not_applicable, undefined);
      assert.equal(result.actual.reason, 'no_schema_registered');
    });
    await t.test(`${ext}: ordinary nested/concurrent runs shadow opt-in and scope unwinds on errors`, async () => {
      const before = source(() => check(validations));
      await source(() => loader.withCreativeBuildProbeSchemaScope(true, async () => {
        const results = await Promise.all([
          Promise.resolve().then(() => check(validations)),
          loader.withCreativeBuildProbeSchemaScope(false, async () => {
            await new Promise(resolve => setImmediate(resolve));
            return check(validations);
          }),
        ]);
        assert.equal(results[0].strict.lenient_valid, false);
        assert.deepEqual(results[1], before);
        assert.equal(loader.isCreativeBuildProbeSchemaScopeActive(), true);
      }));
      assert.throws(() => loader.withCreativeBuildProbeSchemaScope(true, () => { throw new Error('scope cleanup'); }), /scope cleanup/);
      assert.equal(loader.isCreativeBuildProbeSchemaScopeActive(), false);
      assert.deepEqual(source(() => check(validations)), before);
    });
    await t.test(`${ext}: actual capability preflight honors scope before validating borrowed client facts`, async () => {
      const mock = {
        getAgentInfo: async () => ({ name: 'Sandbox', tools: [{ name: 'get_adcp_capabilities' }] }),
        getAdcpCapabilities: async () => ({ success: true, data: governanceCatalog() }),
        getAdcpVersion: () => '3.2.5',
      };
      const original = await stockSource(() => originalClientModule.discoverAgentProfile(mock, undefined, '3.2.5'));
      const ordinary = await source(() => clientModule.discoverAgentProfile(mock, undefined, '3.2.5'));
      assert.deepEqual(ordinary.profile, original.profile);
      const opted = await source(() => loader.withCreativeBuildProbeSchemaScope(true,
        () => clientModule.discoverAgentProfile(mock, undefined, '3.2.5')));
      assert.equal(opted.profile.capabilities_schema_issues, undefined);
      assert.deepEqual(opted.profile.raw_capabilities, governanceCatalog());
      const invalid = governanceCatalog(); invalid.adcp.idempotency = { supported: true, replay_ttl_seconds: 1 };
      const rejected = await source(() => loader.withCreativeBuildProbeSchemaScope(true,
        () => clientModule.discoverAgentProfile({ ...mock, getAdcpCapabilities: async () => ({ success: true, data: invalid }) }, undefined, '3.2.5')));
      assert.ok(rejected.profile.capabilities_schema_issues.length > 0);
      assert.match(rejected.profile.capabilities_schema_issues[0].message, /Capability catalog JSON schema 3.2-rc.7/);
    });
    await t.test(`${ext}: unauthorized echoes retain pinned authority inside opted scope`, () => {
      source(() => loader.withCreativeBuildProbeSchemaScope(true, () => {
        for (const echo of ['4.0', 'latest', '../../etc', '3.1.29', '3.2-..']) {
          const data = governanceCatalog(); data.adcp_version = echo; data.adcp.supported_versions = [echo];
          const result = check(validations, data);
          assert.match(result.schema_url, /schemas\/3\.2\.5\//, echo);
        }
        const data = governanceCatalog(); data.adcp.supported_versions = ['3.2'];
        assert.match(check(validations, data).schema_url, /schemas\/3\.2\.5\//);
      }));
    });
    await t.test(`${ext}: non-capability checks preserve stock14 even inside opted scope`, () => {
      const context = { taskName: 'get_products', responseSchemaRef: 'media-buy/get-products-response.json',
        taskResult: { success: true, data: { status: 'completed', products: [] } } };
      const original = stockSource(() => check(originalValidations, undefined, context));
      const actual = source(() => loader.withCreativeBuildProbeSchemaScope(true, () => check(validations, undefined, context)));
      assert.deepEqual(actual, original);
    });
    await t.test(`${ext}: direct helper explicitly resolves served facts without scope or inside false scope`, async () => {
      const helper = await load(path.join(sdkRoot, `dist/lib/testing/storyboard/creative-build-probe.${ext}`));
      const caps = { adcp_version: '3.2', adcp: { supported_versions: ['3.1', '3.2'] }, creative: {
        supports_transformation: true,
        supported_formats: [{ capability_id: 'audio-build', operations: ['build'],
          format: { format_kind: 'audio_vast', params: {}, v1_format_ref: [named] } }],
      } };
      const kit = { creative_build_probes: [{
        match: [{ path: '/format/format_kind', operator: 'equals', value: 'audio_vast' }],
        input: { target_format_id: named, creative_manifest: { format_id: named, assets: {} } },
      }] };
      loader.withExternalSchemaRoot('3.1.29', path.join(schemaData, '3.1.29'), () =>
        loader.withServedReleaseSchemaRoots({ '3.2.5': hostedRoot }, () => {
          const call = () => helper.prepareCreativeBuildProbe(caps, { context_prefix: 'build', message: 'Make a sandbox creative' }, kit, '3.1.29');
          const direct = call();
          assert.equal(direct.status, 'resolved');
          assert.deepEqual(loader.withCreativeBuildProbeSchemaScope(false, call), direct);
          assert.deepEqual(loader.withCreativeBuildProbeSchemaScope(true, call), direct);
          assert.equal(loader.isCreativeBuildProbeSchemaScopeActive(), false);
        }));
    });
  }
});

for (const ext of ['js', 'mjs']) {
  test(`${ext}: public full/standalone preserve stock acceptance-catalog behavior and defer probe-only roots`, async t => {
    const stock = reconstructStock(t);
    const { pathToFileURL } = require('node:url');
    const load = file => ext === 'js' ? require(file) : import(pathToFileURL(file).href);
    const api = await load(path.join(sdkRoot, `dist/lib/testing/index.${ext}`));
    const original = await load(path.join(stock, `dist/lib/testing/index.${ext}`));
    const data = governanceCatalog();
    data.media_buy = { acceptance_policy_discovery: {
      catalog_url: 'https://catalog.example/policy.json', catalog_digest: `sha256:${'a'.repeat(64)}`,
    } };
    const source = `
id: media_buy_seller/acceptance_policy_discovery
version: "1.0.0"
title: Acceptance authority control
category: media_buy_seller
summary: Preserve real catalog verification after capability validation
phases:
  - id: catalog
    title: Catalog
    steps:
      - id: get_acceptance_policy_capability
        title: Capability metadata
        task: get_adcp_capabilities
        response_schema_ref: protocol/get-adcp-capabilities-response.json
        sample_request: {}
        validations:
          - check: response_schema
  - id: products
    title: Product profiles
    steps:
      - id: get_contextual_products
        title: Product profiles
        task: get_products
        sample_request: {}
        validations: []
`;
    async function execute(module, standalone = false) {
      const storyboard = module.parseStoryboard(source);
      const client = module.withExternalSchemaRoot('3.2.5', path.join(schemaData, '3.2.5'),
        () => module.createTestClient('https://agent.example/mcp', 'mcp', { adcpVersion: '3.2.5' }));
      client.resetContext = () => {};
      client.executeTask = async task => ({ success: true, data: task === 'get_adcp_capabilities' ? structuredClone(data) : { status: 'completed', products: [] } });
      client.getAdcpCapabilities = () => client.executeTask('get_adcp_capabilities');
      client.getProducts = () => client.executeTask('get_products');
      let resolved = 0;
      const profile = { tools: ['get_adcp_capabilities', 'get_products'], raw_capabilities: data,
        capabilities_schema_issues: [{ pointer: '/adcp', message: 'Capability catalog JSON schema 3.2-rc.7: prior opted discovery diagnostic' }] };
      const snapshot = structuredClone(profile);
      const opts = {
        adcpVersion: '3.2.5', schemaRoot: path.join(schemaData, '3.2.5'), _client: client,
        _profile: profile, agentTools: profile.tools,
        // Probe-only configuration must not be validated or registered here.
        servedReleaseSchemaRoots: { invalid: '/nonexistent-probe-only-root' },
        _controllerCapabilities: { detected: false, scenarios: [] },
        _acceptancePolicyDiscoveryDependencies: {
          resolveCatalog: async () => { resolved++; return { ok: true, catalog: { profiles: [] } }; },
        },
      };
      const result = standalone
        ? await module.runStoryboardStep('https://agent.example/mcp', storyboard, 'get_acceptance_policy_capability', opts)
        : await module.runStoryboard('https://agent.example/mcp', storyboard, opts);
      assert.deepEqual(profile, snapshot, 'caller profile remains caller-owned');
      const steps = standalone ? [result] : result.phases.flatMap(phase => phase.steps);
      assert.ok(steps.every(step => step.passed && !step.skipped), JSON.stringify(result));
      assert.equal(resolved, 1, 'actual acceptance verifier must run after valid discovery');
      assert.ok(steps[0].validations.some(validation => validation.check === 'acceptance_policy_discovery' && validation.passed));
      if (!standalone) assert.ok(steps[1].validations.some(validation => validation.check === 'acceptance_policy_discovery' && validation.passed));
      return steps.map(step => ({ passed: step.passed, validations: step.validations }));
    }
    for (const standalone of [false, true]) assert.deepEqual(await execute(api, standalone), await execute(original, standalone));
  });

  test(`${ext}: real mixed comply batch defers probe roots and clears inherited opt-in before discovery`, { timeout: 60000 }, async t => {
    const { pathToFileURL } = require('node:url');
    const load = file => ext === 'js' ? require(file) : import(pathToFileURL(file).href);
    const api = await load(path.join(sdkRoot, `dist/lib/testing/index.${ext}`));
    const loader = await load(path.join(sdkRoot, `dist/lib/validation/schema-loader.${ext}`));
    const http = require('node:http');
    const tools = ['get_adcp_capabilities', 'build_creative', 'comply_test_controller'];
    const data = governanceCatalog();
    data.supported_protocols = ['creative'];
    data.creative = { supports_evaluator: true, supports_generation: true, supported_formats: [
      { capability_id: 'sandbox-build', format: { format_kind: 'image', params: {}, technical_requirements_complete: true } },
    ] };
    data.experimental_features.push('creative.evaluator');
    const server = http.createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) { response.writeHead(202).end(); return; }
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Sandbox', version: '1.0.0' } };
      else if (rpc.method === 'tools/list') result = { tools: tools.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) };
      else if (rpc.method === 'tools/call') {
        const payload = rpc.params.name === 'get_adcp_capabilities' ? data : { success: true, scenarios: ['query_upstream_traffic'] };
        result = { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      } else result = {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
    const calls = [];
    // Observe the existing SDK transport hook; requests still traverse the
    // real MCP client/server and are never dispatched by a runner fallback.
    const observeFetch = async (...args) => {
      const request = args[0] instanceof Request ? args[0] : new Request(...args);
      if (request.url.startsWith(endpoint) && request.method === 'POST') {
        const body = await request.clone().text();
        if (body) {
          const rpc = JSON.parse(body);
          calls.push({ method: rpc.method, tool: rpc.params?.name, opted: loader.isCreativeBuildProbeSchemaScopeActive() });
        }
      }
      return fetch(...args);
    };
    const transport = { trustedFetchFn: observeFetch, allowPrivateIp: true };
    // These use owned SDK clients and the actual MCP TaskExecutor. Inspect
    // fetch at dispatch time, so server callback context cannot fake ALS proof.
    for (const opted of [false, true]) {
      for (const standalone of [false, true]) {
        const fixture = api.parseStoryboard(`
id: scope_preflight_control
version: "1.0.0"
title: Scope preflight control
category: creative
summary: Validate the actual client preflight and response authority
${opted ? 'creative_build_probe:\n  context_prefix: build\n  message: Make a sandbox image' : ''}
phases:
  - id: discovery
    title: Discovery
    steps:
      - id: capabilities
        title: Capability schema
        task: get_adcp_capabilities
        response_schema_ref: protocol/get-adcp-capabilities-response.json
        sample_request: {}
        validations:
          - check: response_schema
`);
        const start = calls.length;
        const options = { allow_http: true, transport, adcpVersion: '3.2.5',
          schemaRoot: path.join(schemaData, '3.2.5'), skip_controller_seeding: true,
          _serverAdcpVersion: '3.1.29',
          ...!opted && { servedReleaseSchemaRoots: { invalid: '/nonexistent-probe-only-root' } },
        };
        const result = standalone
          ? await api.runStoryboardStep(endpoint, fixture, 'capabilities', options)
          : await api.runStoryboard(endpoint, fixture, options);
        const steps = standalone ? [result] : result.phases.flatMap(phase => phase.steps);
        assert.ok(steps.every(step => step.passed && !step.skipped), JSON.stringify(result));
        const schema = steps[0].validations.find(validation => validation.check === 'response_schema');
        assert.equal(schema.passed, true);
        assert.equal(schema.strict.valid, true);
        assert.match(schema.schema_url, opted ? /3\.2-rc\.7/ : /3\.2\.5/);
        const dispatched = calls.slice(start).filter(call => call.tool === 'get_adcp_capabilities');
        assert.ok(dispatched.length >= 2, 'owned client performs preflight before the authored capability step');
        assert.ok(dispatched.every(call => call.opted === opted), JSON.stringify(dispatched));
      }
    }
    calls.length = 0;
    await loader.withCreativeBuildProbeSchemaScope(true, async () => {
      await assert.rejects(api.comply(endpoint, {
        allow_http: true,
        transport,
        complianceDir: path.join(__dirname, '../dist/compliance/latest'),
        schemaRoot: path.join(schemaData, '3.2.5'),
        storyboards: ['capability_discovery', 'creative/evaluator_auth'],
        servedReleaseSchemaRoots: { invalid: '/nonexistent-probe-only-root' },
      }), /invalid|version|bundle|schema root/i);
      assert.equal(loader.isCreativeBuildProbeSchemaScopeActive(), true, 'caller scope remains caller-owned');
    });
    const capabilities = calls.filter(call => call.tool === 'get_adcp_capabilities');
    assert.ok(capabilities.length >= 2, JSON.stringify(calls));
    assert.ok(capabilities.every(call => call.opted === false), 'outer discovery and ordinary storyboard shadow the parent opt-in');
    assert.ok(!calls.some(call => call.tool === 'build_creative'), 'invalid probe root is rejected before probe dispatch');
    assert.equal(loader.isCreativeBuildProbeSchemaScopeActive(), false);
  });
}

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
