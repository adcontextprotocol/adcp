#!/usr/bin/env node
/**
 * Wrapper for the storyboard sample_request schema lint. Fails CI on any
 * new drift beyond the known-issues allowlist or on stale entries that
 * were never removed after a fix.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { ADCP_ENVELOPE_FIELDS } = require('@adcp/sdk');

const {
  lintAll,
  loadAllowlist,
  reconcileAgainstAllowlist,
  fingerprintError,
  formatViolation,
  entryKey,
  isNegativeStep,
  normalizeSubstitutions,
  normalizeStoryboardSampleRequests,
  loadSchema,
  validateStep,
  STORYBOARD_DIR,
} = require('../scripts/lint-storyboard-sample-request-schema.cjs');

const CONCRETE_2026_RE = /^2026-\d{2}-\d{2}T/;
const ALLOWED_TEMPORAL_NEGATIVE_STEPS = new Set([
  'universal/schema-validation.yaml#past_start_rejection/create_buy_past_start_reject',
]);

function isExplicitTemporalNegativeStep(rel, phase, step) {
  const key = `${rel}#${phase.id}/${step.id}`;
  if (ALLOWED_TEMPORAL_NEGATIVE_STEPS.has(key)) return true;
  return step.expect_error === true && step.negative_path === 'payload_well_formed' && step.comply_scenario === 'temporal_validation';
}

function storyboardFiles(dir = STORYBOARD_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...storyboardFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectConcrete2026CreateMediaBuyDates() {
  const violations = [];
  for (const file of storyboardFiles()) {
    const rel = path.relative(STORYBOARD_DIR, file);
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    for (const phase of doc?.phases || []) {
      for (const step of phase?.steps || []) {
        if (!step || typeof step !== 'object') continue;
        const candidates = [];
        if (step.task === 'create_media_buy') {
          candidates.push(['sample_request', step.sample_request]);
        }
        if (step.sample_request?.tool === 'create_media_buy') {
          candidates.push(['sample_request.payload', step.sample_request.payload]);
        }
        if (step.rate_limit_trip?.trip_target_task === 'create_media_buy') {
          candidates.push(['rate_limit_trip.trip_target_sample_request', step.rate_limit_trip.trip_target_sample_request]);
        }
        for (const [location, payload] of candidates) {
          if (isExplicitTemporalNegativeStep(rel, phase, step)) continue;
          for (const field of ['start_time', 'end_time']) {
            const value = payload?.[field];
            if (typeof value === 'string' && CONCRETE_2026_RE.test(value)) {
              violations.push(`${rel} :: ${phase.id}/${step.id} ${location}.${field} = ${JSON.stringify(value)}`);
            }
          }
          for (const [index, pkg] of Object.entries(payload?.packages || [])) {
            for (const field of ['start_time', 'end_time']) {
              const value = pkg?.[field];
              if (typeof value === 'string' && CONCRETE_2026_RE.test(value)) {
                violations.push(`${rel} :: ${phase.id}/${step.id} ${location}.packages[${index}].${field} = ${JSON.stringify(value)}`);
              }
            }
          }
        }
      }
    }
  }
  return violations;
}

test('no storyboard YAML parse errors', async () => {
  const { parseErrors } = await lintAll();
  if (parseErrors.length > 0) {
    const rendered = parseErrors.map((p) => `  ${p.file}: ${p.error}`).join('\n');
    assert.fail(
      `${parseErrors.length} storyboard file(s) failed to parse. Fix the YAML before running lint:\n${rendered}`,
    );
  }
});

test('no new sample_request schema drift beyond the allowlist', async () => {
  const { violations } = await lintAll();
  const allowlist = loadAllowlist();
  const { newDrift } = reconcileAgainstAllowlist(violations, allowlist);
  if (newDrift.length > 0) {
    const rendered = newDrift.map(formatViolation).join('\n');
    assert.fail(
      `${newDrift.length} step(s) have sample_request schema drift that is not in the allowlist.\n` +
        'Fix the fixture to match the schema, or (rarely) regenerate the allowlist if the drift is deliberate and pending a fix:\n' +
        '  node scripts/lint-storyboard-sample-request-schema.cjs --write-allowlist\n\n' +
        rendered,
    );
  }
});

test('allowlist has no stale entries', async () => {
  const { violations } = await lintAll();
  const allowlist = loadAllowlist();
  const { stale } = reconcileAgainstAllowlist(violations, allowlist);
  if (stale.length > 0) {
    const rendered = stale.map((s) => `  ${s.key}`).join('\n');
    assert.fail(
      `${stale.length} allowlist entr${stale.length === 1 ? 'y is' : 'ies are'} stale — the drift was fixed but the entry was not removed.\n` +
        'Regenerate the allowlist:\n' +
        '  node scripts/lint-storyboard-sample-request-schema.cjs --write-allowlist\n\n' +
        rendered,
    );
  }
});

test('create_media_buy sample requests avoid concrete 2026 flight dates', () => {
  const violations = collectConcrete2026CreateMediaBuyDates();
  if (violations.length > 0) {
    assert.fail(
      `${violations.length} create_media_buy sample_request flight date value(s) hard-code 2026 outside explicit temporal negative tests.\n` +
        'Use start_time: "asap" and far-future end_time values for durable positive-path samples, or far-future reversed dates for temporal negatives:\n' +
        violations.map((v) => `  ${v}`).join('\n'),
    );
  }
});

// Universal storyboards run against every agent, including media-buy agents
// that implement media-buy/list-creative-formats-request.json. The runner
// strips any request field that is neither an AdCP envelope field nor declared
// by that schema, and reports it as an input_schema_field_stripped notice.
test('universal list_creative_formats sample requests only send fields a media-buy agent declares', () => {
  const mediaBuySchema = JSON.parse(
    fs.readFileSync(
      path.resolve(STORYBOARD_DIR, '..', '..', 'schemas', 'source', 'media-buy', 'list-creative-formats-request.json'),
      'utf8',
    ),
  );
  const declared = new Set([...Object.keys(mediaBuySchema.properties), ...ADCP_ENVELOPE_FIELDS]);
  const violations = [];
  for (const file of storyboardFiles(path.join(STORYBOARD_DIR, 'universal'))) {
    const rel = path.relative(STORYBOARD_DIR, file);
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    for (const phase of doc?.phases || []) {
      for (const step of phase?.steps || []) {
        if (step?.task !== 'list_creative_formats') continue;
        const stripped = Object.keys(step.sample_request || {}).filter((field) => !declared.has(field));
        if (stripped.length > 0) {
          violations.push(`${rel} :: ${phase.id}/${step.id} sends ${stripped.join(', ')}`);
        }
      }
    }
  }
  if (violations.length > 0) {
    assert.fail(
      `${violations.length} universal list_creative_formats step(s) send fields that media-buy agents do not declare, so the runner strips them:\n` +
        violations.map((v) => `  ${v}`).join('\n'),
    );
  }
});

test('fingerprintError produces stable output for common error shapes', () => {
  assert.equal(
    fingerprintError({ keyword: 'required', path: '/', params: { missingProperty: 'caller' } }),
    'required@/:caller',
  );
  assert.equal(
    fingerprintError({ keyword: 'additionalProperties', path: '/account', params: { additionalProperty: 'scheme' } }),
    'additionalProperties@/account:scheme',
  );
  assert.equal(
    fingerprintError({ keyword: 'type', path: '/outcome', params: { type: 'string' } }),
    'type@/outcome:string',
  );
  assert.equal(
    fingerprintError({ keyword: 'const', path: '/refine/0/scope', params: { allowedValue: 'request' } }),
    'const@/refine/0/scope:request',
  );
  assert.equal(
    fingerprintError({ keyword: 'const', path: '/shape', params: { allowedValue: { type: 'object' } } }),
    'const@/shape:{"type":"object"}',
  );
});

// Direct unit tests for the ratchet reducer. The end-to-end tests above prove
// the current tree is clean; these prove the classification logic is honest
// regardless of what the tree happens to contain. If a refactor breaks the
// reducer (entryKey mismatch, fingerprint shape flip, etc.), these fail loudly.
test('reconcileAgainstAllowlist classifies new drift, grandfathered, and stale correctly', () => {
  const file = path.join(STORYBOARD_DIR, 'fixture.yaml');
  const grandfatheredViolation = {
    file,
    phaseId: 'phase_a',
    stepId: 'step_grandfathered',
    schemaRef: 'x/y.json',
    errors: [{ path: '/', keyword: 'required', params: { missingProperty: 'caller' } }],
  };
  const newDriftViolation = {
    file,
    phaseId: 'phase_a',
    stepId: 'step_new',
    schemaRef: 'x/y.json',
    errors: [{ path: '/', keyword: 'required', params: { missingProperty: 'caller' } }],
  };
  const grandfatheredPlusNew = {
    file,
    phaseId: 'phase_b',
    stepId: 'step_mixed',
    schemaRef: 'x/y.json',
    errors: [
      { path: '/', keyword: 'required', params: { missingProperty: 'caller' } },
      { path: '/', keyword: 'additionalProperties', params: { additionalProperty: 'bogus' } },
    ],
  };

  const allowlist = {
    entries: {
      [entryKey(file, 'phase_a', 'step_grandfathered')]: {
        schema: 'x/y.json',
        errors: ['required@/:caller'],
      },
      [entryKey(file, 'phase_b', 'step_mixed')]: {
        schema: 'x/y.json',
        errors: ['required@/:caller'],
      },
      [entryKey(file, 'phase_a', 'step_fixed_but_listed')]: {
        schema: 'x/y.json',
        errors: ['required@/:something'],
      },
    },
  };

  const { newDrift, stale, grandfathered } = reconcileAgainstAllowlist(
    [grandfatheredViolation, newDriftViolation, grandfatheredPlusNew],
    allowlist,
  );

  assert.equal(grandfathered.length, 1, 'pure grandfathered violation classified');
  assert.equal(newDrift.length, 2, 'brand-new step and new error on listed step both count as drift');
  const newDriftSteps = newDrift.map((v) => v.stepId).sort();
  assert.deepEqual(newDriftSteps, ['step_mixed', 'step_new']);
  const mixedOnly = newDrift.find((v) => v.stepId === 'step_mixed');
  assert.equal(mixedOnly.errors.length, 1, 'only the unexpected error is kept on a mixed step');
  assert.equal(mixedOnly.errors[0].keyword, 'additionalProperties');

  assert.equal(stale.length, 1, 'allowlist entry with no matching violation is stale');
  assert.ok(stale[0].key.endsWith('#phase_a/step_fixed_but_listed'));
});

test('isNegativeStep detects error-path tests via validations and explicit flag', () => {
  assert.equal(isNegativeStep({ validations: [{ check: 'error_code', value: 'VALIDATION_ERROR' }] }), true);
  assert.equal(isNegativeStep({ validations: [{ check: 'http_status_in', allowed_values: [400, 422] }] }), true);
  assert.equal(isNegativeStep({ validations: [{ check: 'http_status_in', allowed_values: ['4xx', '5xx'] }] }), false); // regex requires digits, not wildcards
  assert.equal(isNegativeStep({ validations: [{ check: 'status_code', value: 404 }] }), true);
  assert.equal(isNegativeStep({ sample_request_skip_schema: true }), true);
  assert.equal(isNegativeStep({ validations: [{ check: 'response_schema' }] }), false);
  assert.equal(isNegativeStep({}), false);
});

test('isNegativeStep branches on negative_path for expect_error steps', () => {
  // Default (no negative_path): expect_error: true skips validation
  assert.equal(isNegativeStep({ expect_error: true }), true);
  // schema_invalid (explicit): skips validation
  assert.equal(isNegativeStep({ expect_error: true, negative_path: 'schema_invalid' }), true);
  // payload_well_formed: validates schema even though expect_error is set
  assert.equal(isNegativeStep({ expect_error: true, negative_path: 'payload_well_formed' }), false);
  // sample_request_skip_schema wins over payload_well_formed
  assert.equal(isNegativeStep({ expect_error: true, negative_path: 'payload_well_formed', sample_request_skip_schema: true }), true);
  // expect_error: false with negative_path: payload_well_formed is a no-op (no expect_error gate)
  assert.equal(isNegativeStep({ expect_error: false, negative_path: 'payload_well_formed' }), false);
});

test('normalizeSubstitutions replaces every live substitution dialect', () => {
  const stringSchema = { type: 'string' };
  // $-prefix forms
  assert.equal(normalizeSubstitutions('$context.plan_id', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('$generate:uuid_v4#tag', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('$test_kit.schemas.primary', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('$from_step:step_a.plan_id', stringSchema), '00000000-0000-4000-8000-000000000000');
  // Handlebars forms
  assert.equal(normalizeSubstitutions('{{runner.webhook_url:step_a}}', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('{{prior_step.step_a.operation_id}}', stringSchema), '00000000-0000-4000-8000-000000000000');
  // Non-substitution literals pass through
  assert.equal(normalizeSubstitutions('plain value', stringSchema), 'plain value');
});

test('normalizeSubstitutions produces a schema-valid digest placeholder', () => {
  const digest = normalizeSubstitutions('$context.terms_digest', {
    type: 'string',
    pattern: '^sha256:[A-Za-z0-9_-]{43}$',
  });
  assert.match(digest, /^sha256:[A-Za-z0-9_-]{43}$/);
});

test('normalizeSubstitutions produces a schema-valid hexadecimal SHA-256 placeholder', () => {
  assert.equal(normalizeSubstitutions('$context.adjustment_digest', {
    type: 'string',
    pattern: '^[A-Fa-f0-9]{64}$',
  }), 'a'.repeat(64));
});

test('normalizeSubstitutions produces a schema-valid currency placeholder', () => {
  assert.equal(normalizeSubstitutions('$context.pricing_currency', {
    type: 'string',
    pattern: '^[A-Z]{3}$',
  }), 'USD');
});

// Object-typed substitution synthesis — the lint change landed in this PR.
// A substitution that lands at an object location (plain or inside a
// discriminated oneOf) must produce a shape-valid placeholder or ajv will
// reject every branch. Regression guard against refactors of `placeholderFor`
// / `synthesizeObject` / `firstObjectBranch`.
test('normalizeSubstitutions synthesizes shape-valid placeholders at object-typed locations', () => {
  const objectSchema = {
    type: 'object',
    required: ['agent_url', 'id'],
    properties: {
      agent_url: { type: 'string', format: 'uri' },
      id: { type: 'string' },
    },
  };
  const synthesized = normalizeSubstitutions('$context.product_format_id', objectSchema);
  assert.equal(typeof synthesized, 'object');
  assert.ok(synthesized !== null && !Array.isArray(synthesized));
  assert.ok('agent_url' in synthesized, 'required agent_url is populated');
  assert.ok('id' in synthesized, 'required id is populated');
  assert.equal(typeof synthesized.agent_url, 'string');
  assert.equal(typeof synthesized.id, 'string');

  // Discriminated oneOf: pick the first object branch and synthesize its required set.
  const oneOfSchema = {
    oneOf: [
      {
        type: 'object',
        required: ['source', 'data_provider_domain', 'id'],
        properties: {
          source: { type: 'string', const: 'catalog' },
          data_provider_domain: { type: 'string' },
          id: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['source', 'agent_url', 'id'],
        properties: {
          source: { type: 'string', const: 'agent' },
          agent_url: { type: 'string', format: 'uri' },
          id: { type: 'string' },
        },
      },
    ],
  };
  const oneOfSynth = normalizeSubstitutions('$context.first_signal_id', oneOfSchema);
  assert.equal(typeof oneOfSynth, 'object');
  // First branch picked; const on discriminator is honored.
  assert.equal(oneOfSynth.source, 'catalog');
  assert.ok('data_provider_domain' in oneOfSynth);
  assert.ok('id' in oneOfSynth);
});

function cancellationCreativeAuthoringFixture() {
  const storyboard = yaml.load(fs.readFileSync(path.join(STORYBOARD_DIR,
    'protocols/media-buy/scenarios/creative_fate_after_cancellation.yaml'), 'utf8'));
  const testKit = yaml.load(fs.readFileSync(path.join(STORYBOARD_DIR,
    storyboard.prerequisites.test_kit), 'utf8'));
  return { storyboard, testKit, steps: storyboard.phases.flatMap(phase => phase.steps || [])
    .filter(step => step.task === 'sync_creatives') };
}

test('static authoring excludes only valid runtime asset directives while wire requests remain strict', async () => {
  const { storyboard, steps } = cancellationCreativeAuthoringFixture();
  assert.equal(steps.length, 2);
  for (const step of steps) {
    const original = structuredClone(step.sample_request);
    const schema = loadSchema(step.schema_ref);
    assert.equal((await validateStep({ schemaRef: step.schema_ref, payload: original })).ok, false,
      'a literal execution directive must never be accepted as a wire asset');
    for (const payload of normalizeStoryboardSampleRequests(storyboard, step, schema)) {
      assert.equal((await validateStep({ schemaRef: step.schema_ref, payload })).ok, true);
      assert.deepEqual(payload.creatives[0].assets, {});
      assert.equal(payload.assignments.length, 1, 'static preparation preserves assignment validation');
    }
    assert.deepEqual(step.sample_request, original, 'static preparation does not rewrite the authored fixture');

    for (const malformed of [42, null, '$context.', 'format_params']) {
      const broken = structuredClone(step);
      broken.sample_request.creatives[0].assets.$build_assets_from_format = malformed;
      for (const payload of normalizeStoryboardSampleRequests(storyboard, broken, schema)) {
        assert.equal((await validateStep({ schemaRef: broken.schema_ref, payload })).ok, false,
          `malformed directive ${JSON.stringify(malformed)} must not be excluded`);
      }
    }
    const badSibling = structuredClone(step);
    badSibling.sample_request.creatives[0].assets.broken_asset = 'not an asset';
    for (const payload of normalizeStoryboardSampleRequests(storyboard, badSibling, schema)) {
      assert.equal((await validateStep({ schemaRef: badSibling.schema_ref, payload })).ok, false,
        'ordinary sibling slots must still be validated');
    }
    const badAssignment = structuredClone(step);
    badAssignment.sample_request.assignments[0].creative_id = 42;
    for (const payload of normalizeStoryboardSampleRequests(storyboard, badAssignment, schema)) {
      assert.equal((await validateStep({ schemaRef: badAssignment.schema_ref, payload })).ok, false,
        'execution syntax must not skip validation of the rest of the request');
    }
  }
});

test('cancellation directives materialize real test-kit assets before strict request validation', async () => {
  const { expandCreativeAssetDirectives, findUnresolvedCreativeAssetDirectives, injectContext } = require('@adcp/sdk/testing');
  const { testKit, steps } = cancellationCreativeAuthoringFixture();
  for (const width of [300, 728]) {
    const height = width === 300 ? 250 : 90;
    const context = {
      format_kind: 'image', format_option_id: `image_${width}x${height}`,
      package_id: 'package_initial', second_package_id: 'package_reuse',
      format_params: { width, height, slots: [
        { asset_group_id: 'image_main', asset_type: 'image', required: true },
        { asset_group_id: 'landing_page_url', asset_type: 'url', required: true },
        { asset_group_id: 'headline', asset_type: 'text', required: true },
      ] },
    };
    for (const step of steps) {
      const injected = injectContext(step.sample_request, context);
      const materialized = expandCreativeAssetDirectives(injected, context, testKit);
      assert.deepEqual(findUnresolvedCreativeAssetDirectives(materialized), []);
      const assets = materialized.creatives[0].assets;
      assert.equal(assets.image_main.asset_type, 'image');
      assert.equal(assets.image_main.width, width);
      assert.equal(assets.image_main.height, height);
      assert.ok(testKit.assets.images.some(image => image.url === assets.image_main.url));
      assert.equal(assets.landing_page_url.url, testKit.assets.click_url);
      assert.equal(assets.headline.asset_type, 'text');
      assert.equal((await validateStep({ schemaRef: step.schema_ref, payload: materialized })).ok, true);

      const corrupt = structuredClone(materialized);
      delete corrupt.creatives[0].assets.image_main.width;
      assert.equal((await validateStep({ schemaRef: step.schema_ref, payload: corrupt })).ok, false,
        'materialized images still require their wire dimensions');

      const unsupported = structuredClone(context);
      unsupported.format_params.slots = [{ asset_group_id: 'legal', asset_type: 'text', required: true }];
      const unavailable = expandCreativeAssetDirectives(
        injectContext(step.sample_request, unsupported), unsupported, testKit);
      assert.notDeepEqual(findUnresolvedCreativeAssetDirectives(unavailable), [],
        'missing fixture semantics are not repaired with arbitrary assets');
      assert.equal((await validateStep({ schemaRef: step.schema_ref, payload: unavailable })).ok, false,
        'an unexpanded fixture-coverage failure cannot become a valid wire request');
    }
  }
});

function evaluatorBuildAuthoringFixture() {
  const storyboard = yaml.load(fs.readFileSync(path.join(STORYBOARD_DIR,
    'protocols/creative/scenarios/evaluator_auth.yaml'), 'utf8'));
  return { storyboard, steps: storyboard.phases.flatMap(phase => phase.steps || [])
    .filter(step => step.task === 'build_creative') };
}

test('all authored evaluator builds materialize valid generation, source, library, transformer and legacy requests', async () => {
  const { storyboard, steps } = evaluatorBuildAuthoringFixture();
  assert.equal(steps.length, 5);
  for (const step of steps) {
    const original = structuredClone(step.sample_request);
    const schema = loadSchema(step.schema_ref);
    const fixtures = normalizeStoryboardSampleRequests(storyboard, step, schema);
    assert.equal(fixtures.length, 5);
    for (const [index, payload] of fixtures.entries()) {
      assert.equal((await validateStep({ schemaRef: step.schema_ref, payload })).ok, true,
        `${step.id} mode ${index} must pass canonical call validation`);
      assert.deepEqual(payload.evaluator, normalizeSubstitutions(original.evaluator, schema.properties.evaluator));
      assert.equal(Object.hasOwn(payload, 'target_capability_id'), index !== 4);
      assert.equal(Object.hasOwn(payload, 'target_format_id'), index === 4);
      assert.equal(Object.hasOwn(payload, 'message'), index === 0);
      assert.equal(Object.hasOwn(payload, 'creative_manifest'), index === 0 || index === 1);
      assert.equal(Object.hasOwn(payload, 'creative_id'), index === 2 || index === 4);
      assert.equal(Object.hasOwn(payload, 'transformer_id'), index === 3);
      assert.equal(Object.hasOwn(payload, 'config'), index === 3);
    }
    assert.deepEqual(step.sample_request, original, 'static preparation must not rewrite authored samples');
  }
});

test('build authoring validation rejects missing selector bindings and retains malformed evaluator negatives', async () => {
  const { storyboard, steps } = evaluatorBuildAuthoringFixture();
  for (const original of steps.slice(0, 2)) {
    const step = structuredClone(original);
    const schema = loadSchema(step.schema_ref);
    assert.equal((await validateStep({ schemaRef: step.schema_ref, payload: step.sample_request })).ok, false,
      'the incomplete pre-injection request must remain invalid');
    step.context_inputs = step.context_inputs.filter(input => !['target_capability_id', 'target_format_id'].includes(input.inject_at));
    for (const payload of normalizeStoryboardSampleRequests(storyboard, step, schema)) {
      assert.equal((await validateStep({ schemaRef: step.schema_ref, payload })).ok, false,
        'the materializer must honor missing authored bindings rather than repair them');
    }
    step.context_inputs = original.context_inputs;
    const evaluator = step.sample_request.evaluator;
    (evaluator.feature_agent || evaluator).agent_url = 42;
    for (const payload of normalizeStoryboardSampleRequests(storyboard, step, schema)) {
      assert.equal((await validateStep({ schemaRef: step.schema_ref, payload })).ok, false,
        'preparation must not repair malformed direct or nested evaluator fields');
    }
  }
});

test('static build preparation requires the authored opt-in contract and rejects invalid injection paths', () => {
  const { storyboard, steps: [step] } = evaluatorBuildAuthoringFixture();
  const schema = loadSchema(step.schema_ref);
  const withoutContract = { ...step, requires_contract: undefined };
  assert.deepEqual(normalizeStoryboardSampleRequests(storyboard, withoutContract, schema),
    [normalizeSubstitutions(step.sample_request, schema)]);
  const malformed = structuredClone(step);
  malformed.context_inputs.find(input => input.key === 'build_capability_id').inject_at = '__proto__.polluted';
  assert.throws(() => normalizeStoryboardSampleRequests(storyboard, malformed, schema),
    /Invalid creative build authoring fixture path/);
});
