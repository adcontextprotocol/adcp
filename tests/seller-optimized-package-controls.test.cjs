'use strict';

// Seller-optimized package controls (budget caps, minimum-spend targets,
// package pacing) are separate capabilities beneath the core
// seller_optimized_budget contract. These tests pin the schema dependency,
// the buyer-filter shape, the field-level gating language, and the
// storyboard applicability matrix so a seller that supports only the core
// shared-budget contract can declare it and pass.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const YAML = require('yaml');
const { runStoryboard } = require('@adcp/sdk/testing');

const ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static', 'schemas', 'source');
const SCENARIOS = path.join(ROOT, 'static', 'compliance', 'source', 'protocols', 'media-buy', 'scenarios');

// Scenarios that create buys on non-guaranteed fixtures also carry a delivery-mode
// gate (adcp#7852). These tests pin the capability gates of the feature under test.
const DELIVERY_GATE_PATH = 'media_buy.supported_delivery_types';
function gatesWithoutDelivery(doc) {
  const predicates = [
    ...(doc.requires_capability ? [doc.requires_capability] : []),
    ...(doc.requires_all_capabilities ?? []),
  ];
  return predicates.filter(predicate => predicate.path !== DELIVERY_GATE_PATH);
}

const SUB_CAPABILITIES = {
  seller_optimized_package_budgets: 'budget',
  seller_optimized_min_spend_targets: 'min_spend_target',
  seller_optimized_package_pacing: 'pacing',
};

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

async function loadSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compileSchema(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

function loadScenario(name) {
  return YAML.parse(fs.readFileSync(path.join(SCENARIOS, `${name}.yaml`), 'utf8'));
}

test('seller declarations of a package-control sub-capability require the core feature', async () => {
  const capabilities = readJson('static/schemas/source/protocol/get-adcp-capabilities-response.json');
  const sellerFeatures = await compileSchema(capabilities.properties.media_buy.properties.features);

  assert.equal(sellerFeatures({ seller_optimized_budget: true }), true, 'core-only declaration is valid');
  assert.equal(
    sellerFeatures({
      seller_optimized_budget: true,
      seller_optimized_package_budgets: true,
      seller_optimized_min_spend_targets: true,
      seller_optimized_package_pacing: true,
    }),
    true,
    'full declaration is valid',
  );
  for (const feature of Object.keys(SUB_CAPABILITIES)) {
    assert.equal(sellerFeatures({ [feature]: true }), false, `${feature} without the parent is a seller error`);
    assert.equal(
      sellerFeatures({ seller_optimized_budget: false, [feature]: true }),
      false,
      `${feature} with a false parent is a seller error`,
    );
    assert.equal(sellerFeatures({ [feature]: false }), true, `${feature}: false needs no parent`);
  }
});

test('buyer required_features filters may request a sub-capability alone', async () => {
  const legacyFilter = await compileSchema(await loadSchema('/schemas/core/media-buy-features.json'));
  const canonicalFilter = await compileSchema(await loadSchema('/schemas/core/canonical-media-buy-features.json'));
  const legacy = readJson('static/schemas/source/core/media-buy-features.json');
  const canonical = readJson('static/schemas/source/core/canonical-media-buy-features.json');
  for (const feature of Object.keys(SUB_CAPABILITIES)) {
    assert.equal(legacyFilter({ [feature]: true }), true, `${feature} is a valid get_products filter`);
    assert.equal(canonicalFilter({ [feature]: true }), true, `${feature} is a valid canonical offer filter`);
    assert.equal(legacy.properties[feature]?.type, 'boolean', `${feature} is a declared boolean feature`);
    assert.equal(canonical.properties[feature]?.type, 'boolean', `${feature} is a declared canonical boolean feature`);
    assert.match(legacy.properties[feature].description, /UNSUPPORTED_FEATURE/);
    assert.match(legacy.properties[feature].description, /seller_optimized_budget: true/);
  }
  const parent = legacy.properties.seller_optimized_budget.description;
  for (const feature of Object.keys(SUB_CAPABILITIES)) assert.ok(parent.includes(feature), `parent names ${feature}`);
  assert.match(parent, /MUST NOT silently drop, soften, or coerce/);
  assert.match(
    parent,
    /UNSUPPORTED_FEATURE` before any over-subscription validation/,
    'undeclared controls are rejected before over-subscription validation',
  );
  assert.match(parent, /applies only to package controls the seller has declared/);
  assert.doesNotMatch(parent, /takes precedence over the sub-capability/);
  const minSpend = legacy.properties.seller_optimized_min_spend_targets.description;
  assert.match(minSpend, /summing above total_budget with `INVALID_REQUEST`/);
  assert.match(minSpend, /over-subscribed target sent to such a seller yields `UNSUPPORTED_FEATURE`/);
});

test('every package-control field names its gating capability', () => {
  const surfaces = [
    'static/schemas/source/media-buy/package-request.json',
    'static/schemas/source/media-buy/package-update.json',
    'static/schemas/source/media-buy/product-purchase.json',
    'static/schemas/source/media-buy/package-control.json',
  ];
  for (const surface of surfaces) {
    const schema = readJson(surface);
    for (const [feature, field] of Object.entries(SUB_CAPABILITIES)) {
      const description = schema.properties[field]?.description ?? '';
      assert.ok(description.includes(feature), `${surface} ${field} references ${feature}`);
      assert.ok(description.includes('UNSUPPORTED_FEATURE'), `${surface} ${field} names the rejection code`);
    }
  }
  const allocation = readJson('static/schemas/source/core/product-allocation.json').properties;
  assert.ok(allocation.max_spend_percentage.description.includes('seller_optimized_package_budgets'));
  assert.ok(allocation.min_spend_target_percentage.description.includes('seller_optimized_min_spend_targets'));
  assert.ok(allocation.pacing.description.includes('seller_optimized_package_pacing'));
});

test('core storyboard phases use only core shared-budget controls', () => {
  const storyboard = loadScenario('seller_optimized_budget');
  assert.deepEqual(gatesWithoutDelivery(storyboard), [{
    path: 'media_buy.features.seller_optimized_budget',
    equals: true,
  }]);
  const gatedPhases = new Set(
    storyboard.phases
      .filter(phase => phase.requires_capability?.path?.startsWith('media_buy.features.seller_optimized_'))
      .map(phase => phase.id),
  );
  for (const phase of storyboard.phases) {
    if (gatedPhases.has(phase.id)) continue;
    for (const step of phase.steps) {
      for (const pkg of step.sample_request?.packages ?? []) {
        for (const field of Object.values(SUB_CAPABILITIES)) {
          assert.equal(pkg[field], undefined, `${phase.id}/${step.id} must not send package ${field}`);
        }
      }
    }
  }
  // Over-subscription INVALID_REQUEST applies only to declared controls.
  const aggregate = storyboard.phases.find(phase => phase.id === 'reject_aggregate_minimum_exceeds_total');
  assert.deepEqual(aggregate.requires_capability, {
    path: 'media_buy.features.seller_optimized_min_spend_targets',
    equals: true,
  });
  assert.equal(
    aggregate.steps[0].validations.find(validation => validation.check === 'error_code')?.value,
    'INVALID_REQUEST',
  );
  assert.equal(
    storyboard.phases.find(phase => phase.id === 'reject_package_minimum_exceeds_budget'),
    undefined,
    'the cross-control cap check lives in its own compound-gated scenario',
  );
  const capCheck = loadScenario('seller_optimized_min_spend_target_exceeds_package_cap');
  assert.deepEqual(gatesWithoutDelivery(capCheck), [
    { path: 'media_buy.features.seller_optimized_budget', equals: true },
    { path: 'media_buy.features.seller_optimized_package_budgets', equals: true },
    { path: 'media_buy.features.seller_optimized_min_spend_targets', equals: true },
  ]);
  const capStep = capCheck.phases.at(-1).steps[0];
  assert.equal(capStep.validations.find(validation => validation.check === 'error_code')?.value, 'INVALID_REQUEST');
});

test('each sub-capability has a positive phase and explicit-false and absent negative phases', () => {
  const storyboard = loadScenario('seller_optimized_budget');
  for (const [feature, field] of Object.entries(SUB_CAPABILITIES)) {
    const path = `media_buy.features.${feature}`;
    const phases = storyboard.phases.filter(phase => phase.requires_capability?.path === path);
    const positive = phases.filter(
      phase => phase.requires_capability.equals === true && phase.steps[0].expect_error !== true,
    );
    const explicitFalse = phases.filter(phase => phase.requires_capability.equals === false);
    const absent = phases.filter(phase => phase.requires_capability.present === false);
    assert.equal(positive.length, 1, `${feature} positive phase`);
    assert.equal(explicitFalse.length, 1, `${feature} explicit-false phase`);
    assert.equal(absent.length, 1, `${feature} absent phase`);
    assert.ok(
      positive[0].steps[0].sample_request.packages.some(pkg => pkg[field] !== undefined),
      `${feature} positive phase sends package ${field}`,
    );
    for (const negative of [...explicitFalse, ...absent]) {
      const [step] = negative.steps;
      const packages = step.sample_request.packages;
      if (field === 'budget') {
        assert.ok(
          packages.some(pkg => pkg.min_spend_target > pkg.budget),
          `${negative.id} probes UNSUPPORTED_FEATURE precedence over the cap check`,
        );
      }
      if (field === 'min_spend_target') {
        const minimums = packages.reduce((sum, pkg) => sum + (pkg.min_spend_target ?? 0), 0);
        assert.ok(
          minimums > step.sample_request.total_budget.amount,
          `${negative.id} probes UNSUPPORTED_FEATURE precedence over the aggregate check`,
        );
      }
      assert.equal(step.expect_error, true);
      assert.ok(step.sample_request.packages.some(pkg => pkg[field] !== undefined));
      assert.equal(
        step.validations.find(validation => validation.check === 'error_code')?.value,
        'UNSUPPORTED_FEATURE',
        `${negative.id} requires UNSUPPORTED_FEATURE`,
      );
    }
  }
});

test('proposal-derived package pacing is gated on all three required declarations', () => {
  const storyboard = loadScenario('seller_optimized_proposal_package_pacing');
  assert.deepEqual(gatesWithoutDelivery(storyboard), [
    { path: 'media_buy.features.seller_optimized_budget', equals: true },
    { path: 'media_buy.features.seller_optimized_package_pacing', equals: true },
    { path: 'media_buy.supports_proposals', equals: true },
  ]);
  const index = YAML.parse(
    fs.readFileSync(path.join(ROOT, 'static', 'compliance', 'source', 'protocols', 'media-buy', 'index.yaml'), 'utf8'),
  );
  assert.ok(JSON.stringify(index).includes('media_buy_seller/seller_optimized_proposal_package_pacing'));
  assert.ok(JSON.stringify(index).includes('media_buy_seller/seller_optimized_min_spend_target_exceeds_package_cap'));
  const core = loadScenario('seller_optimized_budget');
  const coreProposal = core.phases.find(phase => phase.id === 'execute_seller_optimized_proposal');
  assert.ok(!JSON.stringify(coreProposal).includes('front_loaded'), 'core proposal phase grades no package pacing');
});

test('runner applies exactly one sub-capability branch for a core-only seller', async () => {
  const storyboard = loadScenario('seller_optimized_budget');
  const tools = ['get_adcp_capabilities', 'sync_accounts', 'get_products', 'create_media_buy', 'get_media_buys', 'comply_test_controller'];
  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools,
      raw_capabilities: {
        media_buy: {
          features: { seller_optimized_budget: true, seller_optimized_package_pacing: false },
          supported_delivery_types: ['guaranteed', 'non_guaranteed'],
        },
      },
    },
    agentTools: tools,
    _client: new Proxy({}, {
      get(_target, name) {
        if (name === 'resetContext') return () => {};
        return async () => {
          throw new Error('mock transport');
        };
      },
    }),
  });
  const applicable = new Map(
    result.phases.map(phase => [phase.phase_id, phase.steps.some(step => step.skip_reason !== 'not_applicable')]),
  );
  for (const phaseId of ['package_budgets', 'min_spend_targets', 'package_pacing']) {
    assert.equal(applicable.get(phaseId), false, `${phaseId} is not applicable without its declaration`);
  }
  assert.equal(applicable.get('reject_package_budgets_not_advertised'), true);
  assert.equal(applicable.get('reject_package_budgets_explicitly_disabled'), false);
  assert.equal(applicable.get('reject_min_spend_targets_not_advertised'), true);
  assert.equal(applicable.get('reject_min_spend_targets_explicitly_disabled'), false);
  assert.equal(applicable.get('reject_package_pacing_explicitly_disabled'), true);
  assert.equal(applicable.get('reject_package_pacing_not_advertised'), false);
  assert.equal(applicable.get('create_shared_budget_buy'), true, 'core phases always apply');
  assert.equal(
    applicable.get('reject_aggregate_minimum_exceeds_total'),
    false,
    'aggregate over-subscription is not graded for an undeclared minimum-spend control',
  );
});

test('core media-buy pacing guarantees only omitted or even pacing without coercion', () => {
  const parent = readJson('static/schemas/source/core/media-buy-features.json').properties.seller_optimized_budget.description;
  assert.match(parent, /MUST accept omitted media-buy pacing/);
  assert.match(parent, /MAY reject `asap` or `front_loaded` with `UNSUPPORTED_FEATURE` \(error\.field `pacing`\)/);
  assert.match(parent, /MUST NOT silently coerce them to `even`/);
  for (const surface of [
    'static/schemas/source/media-buy/create-media-buy-request.json',
    'static/schemas/source/media-buy/update-media-buy-request.json',
    'static/schemas/source/media-buy/buy-products-request.json',
    'static/schemas/source/media-buy/control-media-buy-request.json',
  ]) {
    const description = readJson(surface).properties.pacing.description ?? '';
    assert.match(description, /MAY reject `asap` or `front_loaded` with UNSUPPORTED_FEATURE/, `${surface} pacing`);
    assert.match(description, /Fixed-allocation semantics are unchanged/, `${surface} leaves fixed mode alone`);
  }
  const storyboard = loadScenario('seller_optimized_budget');
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      const pacing = step.sample_request?.pacing;
      assert.ok(pacing === undefined || pacing === 'even', `${phase.id}/${step.id} uses only core media-buy pacing`);
    }
  }
});

test('buyer agents are told to send budget_allocation explicitly and ask when ambiguous', () => {
  const create = readJson('static/schemas/source/media-buy/create-media-buy-request.json').properties.budget_allocation.description;
  const core = readJson('static/schemas/source/core/budget-allocation.json').description;
  for (const description of [create, core]) {
    assert.match(description, /fixed allocation \(legacy-compatible\)/);
    assert.match(description, /SHOULD send/);
    assert.match(description, /SHOULD ask the principal rather than guess/);
  }
});
