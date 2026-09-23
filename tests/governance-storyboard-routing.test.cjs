const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { loadStoryboardFile } = require('@adcp/sdk/testing');

const SCENARIOS = ['governance_approved', 'governance_conditions'];

for (const scenarioName of SCENARIOS) {
  test(`${scenarioName} routes the governance setup and carries its plan ID`, () => {
    const scenarioPath = path.join(
      process.cwd(),
      'static/compliance/source/protocols/media-buy/scenarios',
      `${scenarioName}.yaml`,
    );
    const scenario = YAML.parse(fs.readFileSync(scenarioPath, 'utf8'));
    const steps = scenario.phases.flatMap((phase) => phase.steps);
    const syncPlans = steps.find((step) => step.id === 'sync_plans');
    const createMediaBuy = steps.find((step) => step.task === 'create_media_buy');

    assert.deepEqual(scenario.requires_capability, {
      path: 'media_buy.governance_aware',
      equals: true,
    });
    assert.deepEqual(scenario.requires, ['multi_agent']);
    assert.equal(scenario.default_agent, 'sales');
    assert.equal(syncPlans.agent, 'governance');
    assert.ok(
      syncPlans.context_outputs.some(
        (output) => output.name === 'plan_id' && output.path === 'plans[0].plan_id',
      ),
    );
    assert.equal(createMediaBuy.agent, 'sales');
    assert.equal(createMediaBuy.sample_request.plan_id, '$context.plan_id');

    for (const step of steps.filter((candidate) => candidate !== syncPlans)) {
      assert.equal(step.agent, 'sales', `${step.id} must route to the sales agent`);
    }
  });
}

const NON_GOVERNANCE_STORYBOARDS = [
  {
    path: 'static/compliance/source/protocols/media-buy/index.yaml',
    operator: 'media-buy-lifecycle.pinnacle-agency.example',
  },
  {
    path: 'static/compliance/source/specialisms/creative-generative/generative-seller.yaml',
    operator: 'generative-seller.pinnacle-agency.example',
  },
  {
    path: 'static/compliance/source/specialisms/sales-broadcast-tv/index.yaml',
    operator: 'broadcast-tv.pinnacle-agency.example',
  },
  {
    path: 'static/compliance/source/specialisms/sales-catalog-driven/index.yaml',
    operator: 'catalog-driven.pinnacle-agency.example',
  },
  {
    path: 'static/compliance/source/specialisms/sales-guaranteed/index.yaml',
    operator: 'sales-guaranteed.pinnacle-agency.example',
  },
  {
    path: 'static/compliance/source/specialisms/sales-non-guaranteed/index.yaml',
    operator: 'sales-non-guaranteed.pinnacle-agency.example',
  },
];

function load(relativePath) {
  return loadStoryboardFile(path.join(process.cwd(), relativePath));
}

function storyboardSteps(storyboard) {
  return storyboard.phases.flatMap((phase) => phase.steps);
}

function sameNaturalKey(left, right) {
  return left.brand?.domain === right.brand?.domain &&
    left.operator === right.operator &&
    (left.sandbox === true) === (right.sandbox === true) &&
    left.timezone === right.timezone;
}

test('base media-buy lifecycle loads with explicit, ungoverned account references', () => {
  const storyboard = load(NON_GOVERNANCE_STORYBOARDS[0].path);
  const steps = storyboard.phases.flatMap((phase) => phase.steps);
  const phaseIds = new Set(storyboard.phases.map((phase) => phase.id));

  assert.ok(!phaseIds.has('governance_setup'));
  assert.ok(!phaseIds.has('buyer_selected_governance_setup'));
  assert.ok(!steps.some((step) => step.task === 'sync_governance'));

  const syncAccount = steps.find((step) => step.id === 'sync_accounts');
  const createBuy = steps.find((step) => step.id === 'create_media_buy');
  const provisioningEntry = syncAccount.sample_request.accounts[0];
  const expectedRef = {
    brand: { domain: 'acmeoutdoor.example' },
    operator: 'media-buy-lifecycle.pinnacle-agency.example',
    sandbox: true,
  };
  assert.deepEqual(createBuy.sample_request.account, expectedRef);
  assert.deepEqual(
    {
      brand: provisioningEntry.brand,
      operator: provisioningEntry.operator,
      sandbox: provisioningEntry.sandbox,
    },
    expectedRef,
  );
  assert.equal(provisioningEntry['<<'], undefined);
  assert.equal(provisioningEntry.billing, 'operator');
  assert.equal(provisioningEntry.payment_terms, 'net_30');
  assert.equal(createBuy.sample_request.governance_context, undefined);
});

test('non-governance storyboards use isolated account natural keys', () => {
  const operators = new Set();

  for (const definition of NON_GOVERNANCE_STORYBOARDS) {
    const storyboard = load(definition.path);
    const steps = storyboardSteps(storyboard);
    assert.ok(!storyboard.required_tools.includes('sync_governance'), definition.path);
    assert.ok(!steps.some((step) => step.task === 'sync_governance'), definition.path);
    assert.equal(storyboard.context?.governance_agent_url, undefined, definition.path);

    const accountRefs = steps.flatMap((step) => {
      const request = step.sample_request;
      if (!request) return [];
      const refs = request.account ? [request.account] : [];
      if (step.task === 'sync_accounts') refs.push(...(request.accounts ?? []));
      return refs;
    });
    assert.ok(accountRefs.length > 0, definition.path);
    for (const account of accountRefs) {
      assert.equal(account.operator, definition.operator, definition.path);
    }

    const provisionedAccounts = [
      ...(storyboard.fixtures?.accounts ?? []).map((entry) => entry.fixture),
      ...steps
        .filter((step) => step.task === 'sync_accounts')
        .flatMap((step) => step.sample_request?.accounts ?? []),
    ];
    const provisionedDomains = new Set(
      provisionedAccounts.map((account) => account.brand?.domain).filter(Boolean),
    );
    for (const account of accountRefs.filter((ref) => provisionedDomains.has(ref.brand?.domain))) {
      assert.ok(
        provisionedAccounts.some((candidate) => sameNaturalKey(candidate, account)),
        `${definition.path} does not provision ${JSON.stringify(account)}`,
      );
    }
    operators.add(definition.operator);
  }

  assert.equal(operators.size, NON_GOVERNANCE_STORYBOARDS.length);
});

test('catalog-driven account references preserve the provisioned sandbox key', () => {
  const storyboard = load('static/compliance/source/specialisms/sales-catalog-driven/index.yaml');
  for (const step of storyboardSteps(storyboard)) {
    if (step.sample_request?.account) {
      assert.equal(step.sample_request.account.sandbox, true, step.id);
    }
  }
});
