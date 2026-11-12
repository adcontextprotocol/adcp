#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { runValidations } = require('@adcp/sdk/testing');

// The maintenance runner pinned by this line and the private modern runner
// used by other 3.2.x storyboard tests must both honour the applicability gate.
const RUNNERS = [
  ['@adcp/sdk (maintenance pin)', require('@adcp/sdk/testing')],
  ['fixture-test-sdk (modern runner)', require('@adcp-protocol/fixture-test-sdk/testing')],
];

const POLICY_GATE = '!context.policy_products.0.enforced_policies.0';
const FIXTURE_PRODUCT_ID = 'test-product-policy-backed-rejections';
const FIXTURE_POLICIES = ['creative_security_auto_redirect', 'creative_security_https_only'];

const STORYBOARD_PATH = path.join(
  __dirname,
  '..',
  'static/compliance/source/protocols/creative/scenarios/policy_backed_rejections.yaml',
);
const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'static/test-assets/acme-outdoor/policy-backed-auto-redirect-http.js',
);
const MINTIGNORE_PATH = path.join(__dirname, '..', '.mintignore');

function loadStoryboard() {
  return yaml.load(fs.readFileSync(STORYBOARD_PATH, 'utf8'));
}

function rejectionStep(storyboard = loadStoryboard()) {
  return storyboard.phases
    .find(phase => phase.id === 'reject_multiple_policies')
    .steps.find(step => step.id === 'sync_dual_violation_creative');
}

function policyError(policyId) {
  return {
    code: 'CREATIVE_REJECTED',
    message: `Rejected by ${policyId}`,
    details: { policy_id: policyId },
  };
}

function gradeRejection(errors) {
  const validations = rejectionStep().validations.filter(validation => validation.check !== 'response_schema');
  return runValidations(validations, {
    taskName: 'sync_creatives',
    agentUrl: 'https://seller.example',
    contributions: new Set(),
    taskResult: {
      success: true,
      data: { creatives: [{ creative_id: 'fixture', action: 'failed', errors }] },
    },
  });
}

test('fixture gates applicability on an isolated two-policy product and canonical display tag', () => {
  const storyboard = loadStoryboard();
  const product = storyboard.fixtures.products[0];
  const step = rejectionStep(storyboard);
  const tag = step.sample_request.creatives[0].assets.tag_url;

  assert.equal(storyboard.id, 'creative/policy_backed_rejections');
  assert.deepEqual(storyboard.requires, ['controller']);
  assert.equal(storyboard.prerequisites.controller_seeding, true);
  assert.deepEqual(product.enforced_policies, [
    'creative_security_auto_redirect',
    'creative_security_https_only',
  ]);
  assert.equal(tag.asset_type, 'url');
  assert.equal(tag.url_type, 'tracker_script');
  assert.equal(
    tag.url,
    'https://adcontextprotocol.org/test-assets/acme-outdoor/policy-backed-auto-redirect-http.js',
  );
  const fixtureSource = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.match(fixtureSource, /window\.location\.assign\(/);
  assert.match(fixtureSource, /fetch\('http:\/\//);
});

test('executable fixture is excluded from Mintlify global custom scripts', () => {
  const mintignore = fs.readFileSync(MINTIGNORE_PATH, 'utf8');
  assert.match(mintignore, /^static\/test-assets\/\*\*\/\*\.js$/m);
});

test('conformance requires exactly two separate policy-backed rejection entries', () => {
  const step = rejectionStep();
  const validations = step.validations;
  const count = validations.find(validation => validation.check === 'array_length');
  const entries = validations
    .filter(validation => validation.check === 'field_contains' && validation.path === 'creatives[0].errors[*]')
    .map(validation => validation.value);

  assert.deepEqual(count, {
    check: 'array_length',
    path: 'creatives[0].errors',
    value: 2,
    description: 'Exactly one error entry is emitted for each of the two violated policies',
  });
  assert.deepEqual(
    new Set(entries.map(entry => entry.details.policy_id)),
    new Set(['creative_security_auto_redirect', 'creative_security_https_only']),
  );
  assert.ok(entries.every(entry => entry.code === 'CREATIVE_REJECTED'));
});

test('runtime validations reject combined, duplicate, ambiguous, and extra entries', () => {
  const autoRedirect = policyError('creative_security_auto_redirect');
  const httpsOnly = policyError('creative_security_https_only');
  assert.ok(gradeRejection([autoRedirect, httpsOnly]).every(result => result.passed));

  const invalidCases = [
    [{
      code: 'CREATIVE_REJECTED',
      message: 'Combined rejection',
      details: { policy_id: ['creative_security_auto_redirect', 'creative_security_https_only'] },
    }],
    [autoRedirect, autoRedirect],
    [
      { ...autoRedirect, details: { policy_id: 'creative_security_auto_redirect+creative_security_https_only' } },
      { ...httpsOnly, details: { policy_id: null } },
    ],
    [autoRedirect, httpsOnly, policyError('seller_specific_extra_policy')],
  ];

  for (const errors of invalidCases) {
    assert.ok(
      gradeRejection(errors).some(result => !result.passed),
      `expected rejection validations to fail for ${JSON.stringify(errors)}`,
    );
  }
});

// adcp#8850: the 3.2 schemas have no capability a seller can use to opt out
// of registry policy enforcement, so this line gates the enforcement phases on
// what the seller publishes. The controller seeds `enforced_policies`; the
// gate reads the seller's get_products response, never the seed.
test('enforcement phases are gated on the enforced_policies the seller publishes', () => {
  const storyboard = loadStoryboard();
  const [discover, ...gated] = storyboard.phases;

  assert.equal(discover.id, 'discover_policy_applicability');
  assert.equal(discover.skip_if, undefined, 'discovery always runs');
  assert.deepEqual(discover.steps.map(step => step.task), ['get_products']);
  assert.deepEqual(discover.steps[0].context_outputs, [{ key: 'policy_products', path: 'products' }]);
  assert.deepEqual(
    discover.steps[0].validations.map(validation => validation.check),
    ['response_schema'],
    'the ungated read must not assert policy enforcement',
  );

  assert.deepEqual(gated.map(phase => phase.id), ['confirm_enforced_policies', 'reject_multiple_policies']);
  for (const phase of gated) {
    assert.equal(phase.skip_if, POLICY_GATE, `${phase.id} runs only for a seller that publishes enforced_policies`);
  }
  const confirm = gated[0].steps[0];
  assert.equal(confirm.task, 'get_products');
  assert.deepEqual(
    confirm.validations.filter(v => v.path?.startsWith('products[0].enforced_policies')).map(v => v.check),
    ['array_length', 'field_contains', 'field_contains'],
    'an enforcing seller is still graded on the exact policy universe',
  );
  assert.equal(
    confirm.validations.find(v => v.check === 'field_value').value,
    FIXTURE_PRODUCT_ID,
  );
});

function executableStoryboard() {
  const source = loadStoryboard();
  // Response-schema conformance has its own coverage; these mock sellers
  // return only the fields the gate and the enforcement checks read.
  return {
    ...source,
    prerequisites: undefined,
    fixtures: undefined,
    requires: undefined,
    phases: source.phases.map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({
        ...step,
        validations: (step.validations ?? []).filter(validation => validation.check !== 'response_schema'),
      })),
    })),
  };
}

function policyErrorFor(policyId) {
  return { code: 'CREATIVE_REJECTED', message: `Rejected by ${policyId}`, details: { policy_id: policyId } };
}

async function runAgainstSeller(runner, { products, rejectWith }) {
  const storyboard = executableStoryboard();
  const calls = [];
  const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
  const result = await runner.runStoryboard('https://seller.example/mcp', storyboard, {
    _profile: { tools, raw_capabilities: { creative: { has_creative_library: true } } },
    agentTools: tools,
    _client: {
      resetContext() {},
      async getProducts(request) {
        calls.push('get_products');
        return { success: true, data: { products, context: request.context } };
      },
      async syncCreatives(request) {
        calls.push('sync_creatives');
        const creative_id = request.creatives[0].creative_id;
        const creatives = rejectWith
          ? [{ creative_id, action: 'failed', errors: rejectWith.map(policyErrorFor) }]
          : [{ creative_id, action: 'created' }];
        return { success: true, data: { creatives, context: request.context } };
      },
    },
  });
  const steps = result.phases.flatMap(phase => phase.steps);
  return {
    result,
    calls,
    failed: steps.filter(step => !step.passed).map(step => step.step_id),
    executedSteps: steps.filter(step => !step.skipped).map(step => step.step_id),
    executedPhases: result.phases.filter(phase => phase.steps.length > 0).map(phase => phase.phase_id),
  };
}

function fixtureProduct(extra = {}) {
  return {
    product_id: FIXTURE_PRODUCT_ID,
    name: 'Policy-Backed Creative Rejection Test Product',
    pricing_options: [{ pricing_option_id: 'policy-backed-rejections-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
    ...extra,
  };
}

const NON_ENFORCING_SELLERS = [
  ['omits enforced_policies on the seeded product', [fixtureProduct()]],
  ['publishes an empty enforced_policies list', [fixtureProduct({ enforced_policies: [] })]],
  ['filters every product out under required_policies', []],
];

for (const [runnerName, runner] of RUNNERS) {
  for (const [label, products] of NON_ENFORCING_SELLERS) {
    test(`${runnerName}: a seller that ${label} skips enforcement and is not failed`, async () => {
      const run = await runAgainstSeller(runner, { products });

      assert.deepEqual(run.failed, [], JSON.stringify(run.result.phases));
      assert.equal(run.result.failed_count, 0);
      assert.equal(run.result.overall_passed, true);
      assert.deepEqual(run.calls, ['get_products'], 'the violating creative must not be sent');
      assert.deepEqual(run.executedPhases, ['discover_policy_applicability']);
      const skipped = run.result.phases.filter(phase => phase.phase_id !== 'discover_policy_applicability');
      assert.deepEqual(skipped.map(phase => phase.phase_id), ['confirm_enforced_policies', 'reject_multiple_policies']);
      assert.ok(skipped.every(phase => phase.passed && phase.steps.length === 0), 'gated phases skip neutrally');
    });
  }

  test(`${runnerName}: a seller that publishes enforced_policies runs every step`, async () => {
    const run = await runAgainstSeller(runner, {
      products: [fixtureProduct({ enforced_policies: FIXTURE_POLICIES })],
      rejectWith: FIXTURE_POLICIES,
    });

    assert.deepEqual(run.failed, [], JSON.stringify(run.result.phases));
    assert.equal(run.result.overall_passed, true);
    assert.deepEqual(run.calls, ['get_products', 'get_products', 'sync_creatives']);
    assert.deepEqual(run.executedSteps, [
      'get_product_policies',
      'get_product_policies_confirm',
      'sync_dual_violation_creative',
    ]);
  });

  test(`${runnerName}: a seller that publishes enforced_policies but accepts the violating creative fails`, async () => {
    const run = await runAgainstSeller(runner, {
      products: [fixtureProduct({ enforced_policies: FIXTURE_POLICIES })],
    });

    assert.equal(run.result.overall_passed, false);
    assert.deepEqual(run.failed, ['sync_dual_violation_creative']);
    assert.deepEqual(run.calls, ['get_products', 'get_products', 'sync_creatives']);
  });

  test(`${runnerName}: a seller that publishes a different policy universe fails the confirmation`, async () => {
    const run = await runAgainstSeller(runner, {
      products: [fixtureProduct({ enforced_policies: ['seller_specific_policy'] })],
      rejectWith: FIXTURE_POLICIES,
    });

    assert.equal(run.result.overall_passed, false);
    assert.ok(run.failed.includes('get_product_policies_confirm'), JSON.stringify(run.failed));
    assert.ok(run.calls.includes('sync_creatives'), 'publishing any enforced policy keeps the seller in scope');
  });
}
