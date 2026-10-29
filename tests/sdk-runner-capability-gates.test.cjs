#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const {
  parseStoryboard,
  runStoryboard,
  createTestClient,
  applyStoryboardVersionOptions,
  resolveStoryboardsForCapabilities,
  resolveBundleOrStoryboard,
  buildComplianceBundleResults,
} = require('@adcp/sdk/testing');

const mediaBuyScenariosPath = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'protocols',
  'media-buy',
  'scenarios'
);
const creativeScenariosPath = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'protocols',
  'creative',
  'scenarios'
);

function loadMediaBuyStoryboard(name) {
  const candidates = [
    path.join(mediaBuyScenariosPath, `${name}.yaml`),
    path.join(creativeScenariosPath, `${name}.yaml`),
  ];
  const storyboardPath = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(storyboardPath, `Missing storyboard source for ${name}`);
  return YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
}

test('evaluator capability contract grades individual experimental feature declarations', async () => {
  const storyboard = loadMediaBuyStoryboard('evaluator_auth');
  const contract = storyboard.phases.find(phase => phase.id === 'evaluator_capability_contract');
  const executable = {
    ...storyboard,
    prerequisites: undefined,
    fixtures: undefined,
    creative_build_probe: undefined,
    phases: [{
      ...contract,
      steps: contract.steps.map(step => ({
        ...step,
        validations: step.validations.filter(validation => validation.check !== 'response_schema'),
      })),
    }],
  };
  const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];

  for (const features of [[], ['other.feature'], ['creative.evaluator'], ['other.feature', 'creative.evaluator']]) {
    const capabilities = {
      creative: {
        supports_evaluator: true,
        supported_formats: [{ capability_id: 'display-build' }],
      },
      governance: { creative_features: [{ feature_id: 'visual-quality' }] },
      experimental_features: features,
    };
    const requests = [];
    const result = await runStoryboard('https://agent.example/mcp', executable, {
      _profile: { tools, raw_capabilities: capabilities },
      agentTools: tools,
      contracts: ['creative_build_probe_runner'],
      context: { supports_evaluator: true },
      skip_controller_seeding: true,
      _client: {
        resetContext() {},
        async getAdcpCapabilities(request) {
          requests.push(request);
          return { success: true, data: { ...capabilities, context: request.context } };
        },
      },
    });

    assert.equal(requests.length, 1, 'the declared evaluator must execute its capability contract');
    const step = result.phases[0].steps.find(entry => entry.step_id === 'confirm_experimental_feature');
    assert.equal(step.passed, features.includes('creative.evaluator'), JSON.stringify(step));
  }
});

test('phase capability gates do not dispatch dependents with unresolved context', async () => {
  const storyboard = {
    id: 'phase_capability_cascade_regression',
    version: '1.0',
    title: 'Phase capability cascade regression',
    category: 'media_buy',
    summary: 'Regression',
    narrative: 'Regression',
    agent: { interaction_model: 'single_agent', capabilities: [] },
    caller: { role: 'buyer' },
    phases: [
      {
        id: 'setup',
        title: 'Setup',
        requires_capability: {
          path: 'creative.has_creative_library',
          equals: true,
        },
        steps: [
          {
            id: 'create_buy',
            title: 'Create media buy',
            task: 'create_media_buy',
            stateful: true,
            sample_request: { brand_id: 'test' },
            context_outputs: [{ key: 'media_buy_id', path: 'media_buy_id' }],
          },
        ],
      },
      {
        id: 'state_transitions',
        title: 'State transitions',
        steps: [
          {
            id: 'pause_buy',
            title: 'Pause media buy',
            task: 'update_media_buy',
            stateful: true,
            sample_request: {
              media_buy_id: '$context.media_buy_id',
              paused: true,
            },
          },
        ],
      },
    ],
  };
  const dispatchedRequests = [];

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools: ['get_adcp_capabilities', 'create_media_buy', 'update_media_buy'],
      raw_capabilities: { creative: { has_creative_library: false } },
    },
    agentTools: ['get_adcp_capabilities', 'create_media_buy', 'update_media_buy'],
    _client: {
      resetContext() {},
      async createMediaBuy(request) {
        dispatchedRequests.push(request);
        throw new Error('capability-gated setup must not execute');
      },
      async updateMediaBuy(request) {
        dispatchedRequests.push(request);
        throw new Error('dependent phase must not execute');
      },
    },
  });

  assert.deepEqual(dispatchedRequests, []);
  assert.equal(result.failed_count, 0);
  assert.equal(result.phases[0].steps[0].skip_reason, 'not_applicable');
  const dependent = result.phases[1].steps[0];
  assert.equal(dependent.skip_reason, 'capability_prerequisite_unavailable');
  assert.equal(dependent.skip.reason, 'not_applicable');
  assert.match(dependent.skip.detail, /create_buy.*not_applicable/);
});

test('runStoryboard skips an equals-gated storyboard when the capability path is absent', async () => {
  const storyboard = {
    id: 'equals_absent_regression',
    version: '1.0',
    title: 'Equals absent regression',
    category: 'media_buy',
    summary: 'Regression',
    narrative: 'Regression',
    requires_capability: {
      path: 'media_buy.creative_approval_mode',
      equals: 'auto_approve',
    },
    agent: { interaction_model: 'single_agent', capabilities: [] },
    caller: { role: 'buyer' },
    phases: [
      {
        id: 'main',
        title: 'Main',
        steps: [
          {
            id: 'noop',
            title: 'Noop',
            task: 'get_products',
            sample_request: { brief: 'test' },
          },
        ],
      },
    ],
  };

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools: ['get_adcp_capabilities', 'get_products'],
      raw_capabilities: { media_buy: {} },
    },
    agentTools: ['get_adcp_capabilities', 'get_products'],
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.phases[0].phase_id, 'capability_unsupported');
  assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
  assert.match(result.phases[0].steps[0].error, /agent did not declare support/);
});

test('inventory-list storyboards skip sellers that declare property-list support false', async () => {
  const scenariosPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'protocols',
    'media-buy',
    'scenarios'
  );

  for (const name of ['inventory_list_targeting', 'inventory_list_no_match']) {
    const storyboard = YAML.parse(
      fs.readFileSync(path.join(scenariosPath, `${name}.yaml`), 'utf8')
    );
    assert.deepEqual(storyboard.requires_capability, {
      path: 'media_buy.execution.targeting.property_list',
      equals: true,
    });

    const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];
    const result = await runStoryboard('https://agent.example/mcp', storyboard, {
      _profile: {
        tools,
        raw_capabilities: {
          media_buy: { execution: { targeting: { property_list: false } } },
        },
      },
      agentTools: tools,
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.phases[0].phase_id, 'capability_unsupported');
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
    assert.match(result.phases[0].steps[0].error, /execution\.targeting\.property_list/);
  }
});

test('inventory-list no-match requires canonical rejection and fails accepted buys', async () => {
  const storyboardPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'protocols',
    'media-buy',
    'scenarios',
    'inventory_list_no_match.yaml'
  );
  const source = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
  const keepChecks = new Set(['error_code']);
  const storyboard = {
    ...source,
    prerequisites: undefined,
    phases: source.phases.slice(1).map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({
        ...step,
        validations: step.validations.filter(validation => keepChecks.has(validation.check)),
      })),
    })),
  };
  const tools = ['get_adcp_capabilities', 'create_media_buy', 'comply_test_controller'];
  const baseOptions = {
    agentTools: tools,
    context: {
      product_id: 'property-list-product',
      pricing_option_id: 'fixed-price',
    },
    skip_controller_seeding: true,
    _profile: {
      tools,
      raw_capabilities: {
        media_buy: { execution: { targeting: { property_list: true } } },
      },
    },
  };

  const rejection = await runStoryboard('https://agent.example/mcp', storyboard, {
    ...baseOptions,
    _client: {
      resetContext() {},
      async createMediaBuy(request) {
        return {
          success: false,
          data: {
            errors: [{
              code: 'PRODUCT_UNAVAILABLE',
              message: 'The property list matches no inventory',
            }],
            context: request.context,
          },
        };
      },
    },
  });
  assert.equal(rejection.overall_passed, true);
  assert.equal(rejection.passed_count, 1);

  const accepted = await runStoryboard('https://agent.example/mcp', storyboard, {
    ...baseOptions,
    _client: {
      resetContext() {},
      async createMediaBuy(request) {
        return {
          success: true,
          data: {
            media_buy_id: 'silent-buy',
            packages: [{ targeting_overlay: request.packages[0].targeting_overlay }],
            context: request.context,
          },
        };
      },
    },
  });
  assert.equal(accepted.overall_passed, false);
  assert.equal(accepted.failed_count, 1);
});

test('runStoryboard skips a contains-gated phase when the array omits the required value', async () => {
  const storyboard = {
    id: 'phase_contains_regression',
    version: '1.0',
    title: 'Phase contains regression',
    category: 'error_compliance',
    summary: 'Regression',
    narrative: 'Regression',
    agent: { interaction_model: 'single_agent', capabilities: [] },
    caller: { role: 'buyer' },
    phases: [
      {
        id: 'agent_billing',
        title: 'Agent billing',
        requires_capability: {
          path: 'account.supported_billing',
          contains: 'agent',
        },
        steps: [
          {
            id: 'noop',
            title: 'Noop',
            task: 'sync_accounts',
            sample_request: { accounts: [] },
          },
        ],
      },
    ],
  };

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools: ['get_adcp_capabilities', 'sync_accounts'],
      raw_capabilities: { account: { supported_billing: ['operator'] } },
    },
    agentTools: ['get_adcp_capabilities', 'sync_accounts'],
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.phases[0].steps[0].skip_reason, 'not_applicable');
  assert.match(result.phases[0].steps[0].error, /must contain "agent"/);
});

test('runStoryboard skips a not_contains-gated phase when the array contains the excluded value', async () => {
  const storyboard = {
    id: 'phase_not_contains_regression',
    version: '1.0',
    title: 'Phase not-contains regression',
    category: 'error_compliance',
    summary: 'Regression',
    narrative: 'Regression',
    agent: { interaction_model: 'single_agent', capabilities: [] },
    caller: { role: 'buyer' },
    phases: [
      {
        id: 'unsupported_operator_billing',
        title: 'Unsupported operator billing',
        requires_capability: {
          path: 'account.supported_billing',
          not_contains: 'operator',
        },
        steps: [
          {
            id: 'noop',
            title: 'Noop',
            task: 'sync_accounts',
            sample_request: { accounts: [] },
          },
        ],
      },
    ],
  };

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools: ['get_adcp_capabilities', 'sync_accounts'],
      raw_capabilities: { account: { supported_billing: ['operator'] } },
    },
    agentTools: ['get_adcp_capabilities', 'sync_accounts'],
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.phases[0].steps[0].skip_reason, 'not_applicable');
  assert.match(result.phases[0].steps[0].error, /must not contain "operator"/);
});

test('runStoryboard structurally matches object-valued governance task gates', async () => {
  const storyboardPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'specialisms',
    'signal-marketplace',
    'scenarios',
    'governance_denied.yaml'
  );
  const storyboard = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
  const profile = {
    tools: ['get_adcp_capabilities', ...storyboard.required_tools],
    raw_capabilities: {
      adcp: {
        governance_enforcement: {
          tasks: [{ modes: ['signed_context'], task: 'activate_signal' }],
        },
      },
    },
  };

  // Strip executable work to isolate the affirmative gate path without
  // dispatching any storyboard steps over the network.
  const result = await runStoryboard(
    'https://agent.example/mcp',
    { ...storyboard, prerequisites: undefined, phases: [] },
    {
      _profile: profile,
      agentTools: profile.tools,
    }
  );

  assert.equal(result.overall_passed, true);
  assert.equal(result.phases[0].phase_id, 'no_phases');
  assert.equal(result.phases[0].steps[0].skip_reason, 'no_phases');
});

test('online media-buy governance proofs do not apply to signed-context-only sellers', async () => {
  const storyboardPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'protocols',
    'media-buy',
    'scenarios',
    'governance_conditions.yaml'
  );
  const storyboard = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
  const baseProfile = {
    tools: ['get_adcp_capabilities', ...storyboard.required_tools],
    raw_capabilities: {
      adcp: {
        governance_enforcement: {
          tasks: [{ task: 'create_media_buy', modes: ['signed_context'] }],
        },
      },
    },
  };
  const nonExecutable = { ...storyboard, prerequisites: undefined, phases: [] };

  const signedOnly = await runStoryboard('https://agent.example/mcp', nonExecutable, {
    _profile: baseProfile,
    agentTools: baseProfile.tools,
  });
  assert.equal(signedOnly.overall_passed, true);
  assert.equal(signedOnly.phases[0].phase_id, 'capability_unsupported');
  assert.equal(signedOnly.phases[0].steps[0].skip_reason, 'capability_unsupported');
});

function loadBillingGateStoryboard() {
  return YAML.parse(fs.readFileSync(path.join(
    __dirname, '..', 'static', 'compliance', 'source', 'universal', 'billing-gate-dispatch.yaml'
  ), 'utf8'));
}

test('billing gate skips phases when account capabilities are absent', async () => {
  const storyboard = loadBillingGateStoryboard();
  const perAgentPhases = storyboard.phases.filter(phase => phase.id.startsWith('per_agent_gate_'));
  const capabilityDiscovery = storyboard.phases.find(phase => phase.id === 'capability_discovery');

  assert.equal(capabilityDiscovery.optional, undefined);
  assert.deepEqual(capabilityDiscovery.requires_capability, { path: 'account', present: true });

  assert.deepEqual(
    perAgentPhases.map(phase => [phase.id, phase.requires_capability]),
    [
      [
        'per_agent_gate_reject',
        { path: 'account.supported_billing', contains: 'agent' },
      ],
      [
        'per_agent_gate_recover',
        { path: 'account.supported_billing', contains: 'agent' },
      ],
    ]
  );

  const dispatchedTasks = [];
  const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];
  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools,
      raw_capabilities: { media_buy: {} },
    },
    agentTools: tools,
    skip_controller_seeding: true,
    _client: {
      resetContext() {},
      async getAdcpCapabilities() {
        dispatchedTasks.push('get_adcp_capabilities');
        throw new Error('account-gated discovery must not execute');
      },
      async syncAccounts() {
        dispatchedTasks.push('sync_accounts');
        throw new Error('dependent billing gates must not execute');
      },
    },
  });

  assert.deepEqual(dispatchedTasks, []);
  assert.equal(result.overall_passed, true);
  assert.equal(result.failed_count, 0);
  const phases = Object.fromEntries(result.phases.map(phase => [phase.phase_id, phase]));
  assert.equal(phases.capability_discovery.steps[0].skip_reason, 'not_applicable');
  for (const phaseId of [
    'capability_gate_operator',
    'capability_gate_agent',
    'capability_gate_advertiser',
  ]) {
    assert.equal(phases[phaseId].steps[0].skip_reason, 'not_applicable');
    assert.equal(phases[phaseId].steps[0].skip.reason, 'not_applicable');
  }
});

for (const { name, supportedBilling, missingDeclaration } of [
  { name: 'operator billing with omitted-value rejection probes', supportedBilling: ['operator'] },
  { name: 'all billing values with no rejection probes', supportedBilling: ['operator', 'agent', 'advertiser'] },
  { name: 'a missing supported_billing declaration', supportedBilling: ['operator'], missingDeclaration: true },
]) {
  test(`billing gate grades ${name}`, async () => {
    const storyboard = loadBillingGateStoryboard();
    // Exercise all source phases and field validations with the real SDK verdict;
    // schema fetching is independent of this required-phase regression.
    const executable = {
      ...storyboard,
      phases: storyboard.phases.map(phase => ({
        ...phase,
        steps: phase.steps.map(step => ({
          ...step,
          validations: step.validations.filter(validation => validation.check !== 'response_schema'),
        })),
      })),
    };
    const account = {
      supported_billing: supportedBilling,
      supported_account_currency_modes: ['fixed'],
    };
    const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];
    const capabilityRequests = [];
    const rejectedBilling = [];
    const result = await runStoryboard('https://agent.example/mcp', executable, {
      _profile: { tools, raw_capabilities: { account } },
      agentTools: tools,
      test_kit: { commercial_relationship: 'direct' },
      skip_controller_seeding: true,
      _client: {
        resetContext() {},
        async getAdcpCapabilities(request) {
          capabilityRequests.push(request);
          return {
            success: true,
            data: {
              account: missingDeclaration ? { supported_account_currency_modes: ['fixed'] } : account,
              context: request.context,
            },
          };
        },
        async syncAccounts(request) {
          rejectedBilling.push(request.accounts[0].billing);
          return {
            success: true,
            data: {
              accounts: [{
                action: 'failed',
                status: 'rejected',
                errors: [{ code: 'BILLING_NOT_SUPPORTED', recovery: 'correctable', details: { scope: 'capability' } }],
              }],
              context: request.context,
            },
          };
        },
      },
    });

    assert.equal(capabilityRequests.length, 1);
    const discovery = result.phases.find(phase => phase.phase_id === 'capability_discovery');
    assert.equal(discovery.passed, !missingDeclaration);
    assert.equal(discovery.steps.some(step => !step.skipped && step.passed), !missingDeclaration);
    assert.equal(result.overall_passed, !missingDeclaration);
    if (!missingDeclaration) {
      assert.equal(result.failed_count, 0);
      assert.deepEqual(rejectedBilling.sort(), ['operator', 'agent', 'advertiser'].filter(value => !supportedBilling.includes(value)).sort());
      for (const billing of supportedBilling) {
        const gate = result.phases.find(phase => phase.phase_id === `capability_gate_${billing}`);
        assert.ok(gate.steps.every(step => step.skipped && step.skip_reason === 'not_applicable'));
      }
      for (const phaseId of ['per_agent_gate_reject', 'per_agent_gate_recover']) {
        const gate = result.phases.find(phase => phase.phase_id === phaseId);
        assert.ok(gate.steps.every(step => step.skipped), 'direct billing must skip the per-agent passthrough probes');
      }
    }
  });
}

test('create_media_buy async storyboard requires its advertised controller scenario', async () => {
  const storyboardPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'protocols',
    'media-buy',
    'scenarios',
    'create_media_buy_async.yaml'
  );
  const storyboard = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));

  assert.deepEqual(storyboard.requires_capability, {
    path: 'compliance_testing.scenarios',
    contains: 'force_create_media_buy_arm',
  });

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools: ['get_adcp_capabilities', 'create_media_buy', 'comply_test_controller'],
      raw_capabilities: {
        compliance_testing: {
          scenarios: ['force_account_status'],
        },
      },
    },
    agentTools: ['get_adcp_capabilities', 'create_media_buy', 'comply_test_controller'],
  });

  assert.equal(result.overall_passed, true);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.phases[0].phase_id, 'capability_unsupported');
  assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
  assert.match(result.phases[0].steps[0].error, /force_create_media_buy_arm/);

  // Strip executable work to isolate the affirmative gate path without
  // dispatching the compliance controller over the network.
  const advertisedResult = await runStoryboard(
    'https://agent.example/mcp',
    { ...storyboard, prerequisites: undefined, fixtures: undefined, phases: [] },
    {
      _profile: {
        tools: ['get_adcp_capabilities', 'create_media_buy', 'comply_test_controller'],
        raw_capabilities: {
          compliance_testing: {
            scenarios: ['force_create_media_buy_arm'],
          },
        },
      },
      agentTools: ['get_adcp_capabilities', 'create_media_buy', 'comply_test_controller'],
    }
  );

  assert.equal(advertisedResult.overall_passed, true);
  assert.equal(advertisedResult.phases[0].phase_id, 'no_phases');
});

test('creative-library storyboards fail closed before tool execution', async () => {
  const cases = [
    {
      name: 'creative_fate_after_cancellation',
      gate: {
        path: 'creative.has_creative_library',
        equals: true,
      },
      capabilities: { creative: { has_creative_library: true } },
    },
    {
      name: 'list_creatives_filter_behavior',
      gate: {
        path: 'creative.has_creative_library',
        equals: true,
      },
      capabilities: { creative: { has_creative_library: true } },
    },
    {
      name: 'available_actions',
      gates: [
        { path: 'media_buy.creative_approval_mode', equals: 'auto_approve' },
        { path: 'creative.has_creative_library', equals: true },
      ],
      capabilities: {
        creative: { has_creative_library: true },
        media_buy: { creative_approval_mode: 'auto_approve' },
      },
      otherGateFailure: {
        creative: { has_creative_library: true },
        media_buy: { creative_approval_mode: 'require_human' },
      },
    },
    {
      name: 'pending_creatives_to_start',
      gates: [
        { path: 'media_buy.creative_approval_mode', equals: 'auto_approve' },
        { path: 'creative.has_creative_library', equals: true },
      ],
      capabilities: {
        creative: { has_creative_library: true },
        media_buy: { creative_approval_mode: 'auto_approve' },
      },
      otherGateFailure: {
        creative: { has_creative_library: true },
        media_buy: { creative_approval_mode: 'require_human' },
      },
    },
    {
      name: 'dependency_impairment',
      gates: [
        { path: 'media_buy.propagation_surfaces', contains: 'snapshot' },
        { path: 'creative.has_creative_library', equals: true },
      ],
      capabilities: {
        creative: { has_creative_library: true },
        media_buy: { propagation_surfaces: ['snapshot'] },
      },
      otherGateFailure: {
        creative: { has_creative_library: true },
        media_buy: { propagation_surfaces: ['webhook'] },
      },
    },
    {
      name: 'dependency_impairment_cardinality',
      gates: [
        { path: 'media_buy.propagation_surfaces', contains: 'snapshot' },
        { path: 'creative.has_creative_library', equals: true },
      ],
      capabilities: {
        creative: { has_creative_library: true },
        media_buy: { propagation_surfaces: ['snapshot'] },
      },
      otherGateFailure: {
        creative: { has_creative_library: true },
        media_buy: { propagation_surfaces: ['out_of_band'] },
      },
    },
    {
      name: 'per_creative_conversion_attribution',
      gates: [
        {
          path: 'media_buy.conversion_tracking.per_creative_attribution',
          equals: true,
        },
        { path: 'creative.has_creative_library', equals: true },
      ],
      capabilities: {
        creative: { has_creative_library: true },
        media_buy: { conversion_tracking: { per_creative_attribution: true } },
      },
      otherGateFailure: {
        creative: { has_creative_library: true },
        media_buy: { conversion_tracking: { per_creative_attribution: false } },
      },
    },
  ];

  for (const item of cases) {
    const storyboard = loadMediaBuyStoryboard(item.name);
    if (item.gate) {
      assert.deepEqual(storyboard.requires_capability, item.gate);
    } else {
      assert.deepEqual(storyboard.requires_all_capabilities, item.gates);
    }

    const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];
    const librarylessCapabilities = structuredClone(item.capabilities);
    librarylessCapabilities.creative = { has_creative_library: false };
    const libraryless = await runStoryboard('https://agent.example/mcp', storyboard, {
      _profile: { tools, raw_capabilities: librarylessCapabilities },
      agentTools: tools,
    });

    assert.equal(libraryless.overall_passed, true, item.name);
    assert.equal(libraryless.skipped_count, 1, item.name);
    assert.equal(libraryless.phases[0].phase_id, 'capability_unsupported', item.name);
    assert.equal(
      libraryless.phases[0].steps[0].skip_reason,
      'capability_unsupported',
      item.name
    );
    assert.match(libraryless.phases[0].steps[0].error, /creative\.has_creative_library/);

    const applicable = await runStoryboard(
      'https://agent.example/mcp',
      { ...storyboard, prerequisites: undefined, fixtures: undefined, phases: [] },
      {
        _profile: { tools, raw_capabilities: item.capabilities },
        agentTools: tools,
      }
    );
    assert.equal(applicable.overall_passed, true, item.name);
    assert.equal(applicable.phases[0].phase_id, 'no_phases', item.name);

    if (item.otherGateFailure) {
      const outsideOtherScope = await runStoryboard(
        'https://agent.example/mcp',
        storyboard,
        {
          _profile: { tools, raw_capabilities: item.otherGateFailure },
          agentTools: tools,
        }
      );
      assert.equal(outsideOtherScope.overall_passed, true, item.name);
      assert.equal(outsideOtherScope.phases[0].phase_id, 'capability_unsupported', item.name);
    }
  }
});

test('every required seller scenario using library tools has a library capability gate', () => {
  const index = YAML.parse(
    fs.readFileSync(
      path.join(mediaBuyScenariosPath, '..', 'index.yaml'),
      'utf8'
    )
  );
  const libraryTools = new Set(['sync_creatives', 'list_creatives']);

  for (const id of index.requires_scenarios) {
    const storyboard = loadMediaBuyStoryboard(id.split('/').at(-1));
    if (!(storyboard.required_tools || []).some(tool => libraryTools.has(tool))) continue;

    const gates = [
      ...(storyboard.requires_capability ? [storyboard.requires_capability] : []),
      ...(storyboard.requires_all_capabilities || []),
    ];
    assert.ok(
      gates.some(
        gate => gate.path === 'creative.has_creative_library' && gate.equals === true
      ),
      `${id} uses creative-library tools without a creative.has_creative_library gate`
    );
  }
});

test('direct creative-library phases are gated without blocking later lifecycle phases', () => {
  const sourceRoot = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source'
  );
  const indexPaths = [
    path.join(sourceRoot, 'protocols', 'media-buy', 'index.yaml'),
    ...['sales-guaranteed', 'sales-broadcast-tv', 'sales-proposal-mode'].map(name =>
      path.join(sourceRoot, 'specialisms', name, 'index.yaml')
    ),
  ];
  const libraryTools = new Set(['sync_creatives', 'list_creatives']);

  for (const indexPath of indexPaths) {
    const index = YAML.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const phase of index.phases || []) {
      if (!(phase.steps || []).some(step => libraryTools.has(step.task))) continue;
      assert.deepEqual(
        phase.requires_capability,
        { path: 'creative.has_creative_library', equals: true },
        `${index.id}/${phase.id} uses creative-library tools without a phase gate`
      );
    }
  }

  const expectedDownstreamDependencies = new Map([
    ['sales_guaranteed/delivery_monitoring', ['confirm_approved']],
    ['sales_broadcast_tv/delivery_monitoring', ['create_buy']],
    ['sales_broadcast_tv/reconciliation', ['delivery_monitoring']],
    ['sales_proposal_mode/delivery', ['accept_proposal']],
  ]);
  for (const indexPath of indexPaths.slice(1)) {
    const index = YAML.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const phase of index.phases || []) {
      const key = `${index.id}/${phase.id}`;
      if (!expectedDownstreamDependencies.has(key)) continue;
      assert.deepEqual(phase.depends_on, expectedDownstreamDependencies.get(key), key);
      assert.ok(!phase.depends_on.includes('creative_sync'), key);
    }
  }
});

test('product refinement requires the advertised refine buying mode', async () => {
  const storyboard = loadMediaBuyStoryboard('refine_products');
  assert.deepEqual(storyboard.requires_capability, {
    path: 'media_buy.buying_modes',
    contains: 'refine',
  });

  const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];
  const unsupported = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools,
      raw_capabilities: { media_buy: { buying_modes: ['brief'] } },
    },
    agentTools: tools,
  });
  assert.equal(unsupported.overall_passed, true);
  assert.equal(unsupported.phases[0].phase_id, 'capability_unsupported');
  assert.match(unsupported.phases[0].steps[0].error, /media_buy\.buying_modes/);

  const supported = await runStoryboard(
    'https://agent.example/mcp',
    { ...storyboard, prerequisites: undefined, phases: [] },
    {
      _profile: {
        tools,
        raw_capabilities: { media_buy: { buying_modes: ['brief', 'refine'] } },
      },
      agentTools: tools,
    }
  );
  assert.equal(supported.overall_passed, true);
  assert.equal(supported.phases[0].phase_id, 'no_phases');
});

// Exercise the authored phases, gates, context extraction, cascade, and filter
// assertions through the runner. Schema validation is covered separately; this
// client stub returns only the fields needed by the filtering contract.
async function runProductFilterBehavior(buyingModes, brokenMode) {
  const storyboard = loadMediaBuyStoryboard('product_filter_behavior');
  const executable = {
    ...storyboard,
    prerequisites: undefined,
    fixtures: undefined,
    phases: storyboard.phases.map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({
        ...step,
        validations: step.validations.filter(validation => validation.check !== 'response_schema'),
      })),
    })),
  };
  const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
  const requests = [];
  const result = await runStoryboard('https://agent.example/mcp', executable, {
    _profile: {
      tools,
      raw_capabilities: {
        media_buy: buyingModes === undefined ? {} : { buying_modes: buyingModes },
      },
    },
    agentTools: tools,
    skip_controller_seeding: true,
    _client: {
      resetContext() {},
      async getProducts(request) {
        requests.push(request);
        if (request.buying_mode !== 'brief' && !buyingModes?.includes(request.buying_mode)) {
          throw new Error(`Unsupported buying mode: ${request.buying_mode}`);
        }
        const matchingProduct = {
          product_id: request.buying_mode === 'wholesale'
            ? 'filter_behavior_matching_olv'
            : 'product-returned-by-brief',
          channels: ['olv'],
          delivery_type: 'non_guaranteed',
        };
        const products = request.buying_mode === 'refine' || request.filters?.delivery_type === 'guaranteed'
          ? [] : [matchingProduct];
        if (request.buying_mode === brokenMode) {
          products.push(request.buying_mode === 'refine' ? matchingProduct : {
            product_id: 'product-that-should-have-been-filtered-out',
            channels: ['display'],
            delivery_type: 'guaranteed',
          });
        }
        return { success: true, data: { products, context: request.context } };
      },
    },
  });
  const steps = Object.fromEntries(result.phases.map(phase => [phase.phase_id, phase.steps[0]]));
  return { result, requests, steps };
}

test('product filters always test brief and independently test each advertised optional mode', async t => {
  for (const buyingModes of [
    undefined,
    ['brief'],
    ['brief', 'wholesale'],
    ['brief', 'refine'],
    ['brief', 'wholesale', 'refine'],
    ['wholesale'],
    ['refine'],
  ]) {
    await t.test(buyingModes?.join(', ') ?? 'buying_modes absent (defaults to brief)', async () => {
      const { result, requests, steps } = await runProductFilterBehavior(buyingModes);
      const expectedModes = ['brief', 'brief',
        ...(buyingModes?.includes('wholesale') ? ['wholesale', 'wholesale'] : []),
        ...(buyingModes?.includes('refine') ? ['refine'] : [])];
      assert.deepEqual(requests.map(request => request.buying_mode), expectedModes);
      assert.equal(result.overall_passed, true);
      assert.equal(result.failed_count, 0);
      assert.equal(result.passed_count, expectedModes.length);
      assert.equal(result.skipped_count, 5 - expectedModes.length);
      assert.equal(steps.brief_filters.passed, true);
      assert.ok(!steps.brief_filters.skipped, 'universal brief coverage must execute');

      for (const mode of ['wholesale', 'refine']) {
        const step = steps[`${mode}_filters`];
        if (buyingModes?.includes(mode)) {
          assert.equal(step.passed, true);
          assert.ok(!step.skipped, `${mode} coverage must execute when advertised`);
        } else {
          assert.equal(step.skip_reason, 'not_applicable');
          assert.equal(step.skip.reason, 'not_applicable');
        }
      }
      const refineRequest = requests.find(request => request.buying_mode === 'refine');
      if (refineRequest) {
        assert.equal(refineRequest.refine[0].product_id, 'product-returned-by-brief');
      }
    });
  }
});

test('advertised refine still fails when the seller ignores replacement filters', async t => {
  for (const buyingModes of [['brief', 'refine'], ['brief', 'wholesale', 'refine']]) {
    await t.test(buyingModes.join(', '), async () => {
      const { result, requests, steps } = await runProductFilterBehavior(buyingModes, 'refine');
      assert.equal(result.overall_passed, false);
      assert.equal(result.failed_count, 1);
      assert.equal(steps.refine_filters.passed, false);
      assert.ok(!steps.refine_filters.skipped);
      assert.ok(steps.refine_filters.validations.some(validation => !validation.passed));
      assert.equal(requests.at(-1).refine[0].product_id, 'product-returned-by-brief');
    });
  }
});

test('a wholesale filter failure does not suppress supported refine coverage', async () => {
  const { result, requests, steps } = await runProductFilterBehavior(['brief', 'wholesale', 'refine'], 'wholesale');
  assert.deepEqual(requests.map(request => request.buying_mode), ['brief', 'brief', 'wholesale', 'refine']);
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1);
  assert.equal(steps.wholesale_filters.passed, false);
  assert.equal(steps.refine_filters.passed, true);
  assert.ok(!steps.refine_filters.skipped);
  assert.equal(requests.at(-1).refine[0].product_id, 'product-returned-by-brief');
});

test('a brief filter failure blocks dependent refine but leaves wholesale coverage independent', async t => {
  for (const buyingModes of [undefined, ['brief', 'refine'], ['brief', 'wholesale', 'refine']]) {
    await t.test(buyingModes?.join(', ') ?? 'buying_modes absent', async () => {
      const { result, requests, steps } = await runProductFilterBehavior(buyingModes, 'brief');
      assert.equal(result.overall_passed, false);
      assert.equal(steps.brief_filters.passed, false);
      assert.deepEqual(requests.map(request => request.buying_mode),
        buyingModes?.includes('wholesale') ? ['brief', 'wholesale', 'wholesale'] : ['brief']);
      assert.equal(steps.refine_filters.skip_reason,
        buyingModes?.includes('refine') ? 'prerequisite_failed' : 'not_applicable');
      if (buyingModes?.includes('wholesale')) {
        assert.equal(steps.wholesale_filters.passed, true);
        assert.ok(!steps.wholesale_filters.skipped);
      }
    });
  }
});

test('advanced delivery reporting dispatches wholesale discovery only to opted-in sellers', async () => {
  for (const name of ['advanced_delivery_reporting', 'time_based_delivery_reporting']) {
    const storyboard = loadMediaBuyStoryboard(name);
    const executable = {
      ...storyboard,
      // Isolate the buying-mode gate from unrelated account setup. Retain
      // the actual product/pricing declarations and resolver, whose catalog
      // discovery replaced the old authored discover_product step.
      prerequisites: undefined,
      fixtures: { ...storyboard.fixtures, accounts: undefined },
    };
    const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];

    for (const buyingModes of [undefined, ['brief'], ['brief', 'wholesale']]) {
      const requests = [];
      const result = await runStoryboard('https://agent.example/mcp', executable, {
        _profile: {
          tools,
          raw_capabilities: {
            media_buy: buyingModes ? { buying_modes: buyingModes } : {},
          },
        },
        _controllerCapabilities: { detected: true, scenarios: [] },
        agentTools: tools,
        _client: {
          resetContext() {},
          async executeTask(task, request) {
            assert.equal(task, 'get_products', name);
            assert.ok(buyingModes?.includes('wholesale'), 'an unadvertised wholesale read must never dispatch');
            requests.push(request);
            return { success: true, status: 'completed', data: {
              products: [], cache_scope: 'account', wholesale_feed_version: 'gate-test',
            } };
          },
        },
      });

      assert.equal(result.overall_passed, true, JSON.stringify(result));
      if (buyingModes?.includes('wholesale')) {
        assert.equal(requests.length, 1, name);
        assert.equal(requests[0].buying_mode, 'wholesale', name);
        assert.equal(result.failed_count, 0, name);
        assert.equal(result.passed_count, 0, 'a valid catalog no-match is not a feature pass');
        assert.equal(result.skipped_count, 1, name);
        assert.ok(result.coverage_gaps?.some(gap => gap.reason === 'fixture_unsatisfied'), name);
        assert.equal(result.fixture_resolutions[0].status, 'unsatisfied', name);
      } else {
        assert.deepEqual(requests, [], name);
        assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported', name);
        assert.equal(result.passed_count, 0, name);
      }
    }
  }
});

test('proposal finalize skips unsupported replay while still executing the committed proposal', async () => {
  const storyboard = loadMediaBuyStoryboard('proposal_finalize');
  const executable = {
    ...storyboard,
    prerequisites: undefined,
    phases: storyboard.phases
      .filter(phase => ['finalize_proposal', 'finalize_replay', 'accept_proposal', 'unknown_proposal_references'].includes(phase.id))
      .map(phase => ({
        ...phase,
        steps: phase.steps.map(step => ({
          ...step,
          validations: step.validations.filter(validation => phase.id === 'unknown_proposal_references'
            ? validation.check === 'error_code'
            : validation.check !== 'response_schema'),
        })),
      })),
  };
  const tools = ['get_adcp_capabilities', ...storyboard.required_tools, 'comply_test_controller'];

  for (const [supported, brokenReplay] of [[false, false], [true, false], [true, true]]) {
    const finalizedRequests = [];
    const acceptedRequests = [];
    const unknownReferenceRequests = [];
    const unknownProposalError = {
      success: false,
      data: { errors: [{ code: 'PROPOSAL_NOT_FOUND', message: 'Unknown proposal' }] },
    };
    const result = await runStoryboard('https://agent.example/mcp', executable, {
      _profile: {
        tools,
        raw_capabilities: {
          media_buy: { supports_proposals: true },
          adcp: { idempotency: { supported } },
        },
      },
      agentTools: tools,
      context: {
        proposal_id: 'proposal-replay-test',
        finalize_idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      },
      _client: {
        resetContext() {},
        async getProducts(request) {
          if (request.refine[0].proposal_id === 'prop_unknown_proposal_not_found') {
            unknownReferenceRequests.push(request);
            return unknownProposalError;
          }
          finalizedRequests.push(request);
          return {
            success: true,
            data: {
              replayed: supported && !brokenReplay && finalizedRequests.length > 1,
              proposals: [{
                proposal_id: 'proposal-replay-test',
                insertion_order: { io_id: 'io-replay-test' },
                expires_at: '2099-06-30T23:59:59Z',
              }],
            },
          };
        },
        async createMediaBuy(request) {
          if (request.proposal_id === 'prop_unknown_proposal_not_found') {
            unknownReferenceRequests.push(request);
            return unknownProposalError;
          }
          acceptedRequests.push(request);
          return { success: true, data: { media_buy_id: 'accepted-replay-test' } };
        },
      },
    });

    assert.equal(result.overall_passed, !brokenReplay, JSON.stringify(result.phases));
    assert.equal(finalizedRequests.length, supported ? 2 : 1);
    assert.equal(acceptedRequests.length, 1, 'replay opt-out must not skip acceptance');
    assert.equal(unknownReferenceRequests.length, 2, 'replay opt-out must not skip unknown-reference checks');
    assert.equal(acceptedRequests[0].io_acceptance.io_id, 'io-replay-test');
    const replay = result.phases.flatMap(phase => phase.steps)
      .find(step => step.step_id === 'get_products_finalize_replay');
    if (supported) {
      assert.deepEqual(finalizedRequests[1], finalizedRequests[0]);
      assert.equal(replay.passed, !brokenReplay, 'an advertised but broken replay must still fail');
    } else {
      assert.equal(replay.skip_reason, 'not_applicable');
      assert.equal(result.failed_count, 0);
    }
  }
});

test('measurement acceptance is split from the universal rejection scenario', async () => {
  const rejected = loadMediaBuyStoryboard('measurement_terms_rejected');
  const accepted = loadMediaBuyStoryboard('measurement_terms_accepted');
  assert.deepEqual(rejected.phases.map(phase => phase.id), [
    'discover_products',
    'reject_terms',
  ]);
  assert.equal(rejected.requires_capability, undefined);
  assert.deepEqual(accepted.requires_capability, {
    path: 'media_buy.measurement_terms_acceptance',
    equals: true,
  });
  const scenarioIndexes = [
    path.join(mediaBuyScenariosPath, '..', 'index.yaml'),
    ...['sales-guaranteed', 'sales-broadcast-tv', 'sales-proposal-mode'].map(name =>
      path.join(
        __dirname,
        '..',
        'static',
        'compliance',
        'source',
        'specialisms',
        name,
        'index.yaml'
      )
    ),
  ];
  for (const indexPath of scenarioIndexes) {
    const index = YAML.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.ok(index.requires_scenarios.includes('media_buy_seller/measurement_terms_rejected'));
    assert.ok(index.requires_scenarios.includes('media_buy_seller/measurement_terms_accepted'));
  }

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'static',
        'schemas',
        'source',
        'protocol',
        'get-adcp-capabilities-response.json'
      ),
      'utf8'
    )
  );
  const capability = schema.properties.media_buy.properties.measurement_terms_acceptance;
  assert.equal(capability.type, 'boolean');
  assert.equal(capability.default, false);
  assert.equal(capability['x-added-in'], '3.2.0');
  assert.match(capability.description, /TERMS_REJECTED/);

  const tools = ['get_adcp_capabilities', ...accepted.required_tools, 'comply_test_controller'];
  const unsupported = await runStoryboard('https://agent.example/mcp', accepted, {
    _profile: {
      tools,
      raw_capabilities: { media_buy: { measurement_terms_acceptance: false } },
    },
    agentTools: tools,
  });
  assert.equal(unsupported.overall_passed, true);
  assert.equal(unsupported.phases[0].phase_id, 'capability_unsupported');

  const supported = await runStoryboard(
    'https://agent.example/mcp',
    { ...accepted, prerequisites: undefined, phases: [] },
    {
      _profile: {
        tools,
        raw_capabilities: { media_buy: { measurement_terms_acceptance: true } },
      },
      agentTools: tools,
    }
  );
  assert.equal(supported.overall_passed, true);
  assert.equal(supported.phases[0].phase_id, 'no_phases');

  const expectedTerms = {
    billing_measurement: {
      vendor: { domain: 'summit-measurement.example' },
      measurement_window: 'c7',
      max_variance_percent: 10,
    },
    makegood_policy: { available_remedies: ['credit'] },
  };
  let submittedTerms;
  const executable = {
    ...accepted,
    prerequisites: undefined,
    phases: accepted.phases.map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({ ...step, validations: [] })),
    })),
  };
  const workflow = await runStoryboard('https://agent.example/mcp', executable, {
    _profile: {
      tools,
      raw_capabilities: { media_buy: { measurement_terms_acceptance: true } },
    },
    agentTools: tools,
    _client: {
      resetContext() {},
      async getProducts() {
        return {
          success: true,
          data: {
            products: [{
              product_id: 'measurement-product',
              pricing_options: [{ pricing_option_id: 'measurement-price', fixed_price: 12 }],
              measurement_terms: expectedTerms,
            }],
          },
        };
      },
      async createMediaBuy(request) {
        submittedTerms = request.packages[0].measurement_terms;
        return {
          success: true,
          data: {
            media_buy_id: 'measurement-buy',
            packages: [{
              package_id: 'measurement-package',
              measurement_terms: submittedTerms,
            }],
            context: request.context,
          },
        };
      },
    },
  });
  assert.equal(workflow.overall_passed, true);
  assert.deepEqual(submittedTerms, expectedTerms);
});

test('storyboard capability gates use the schema shape the runner evaluates', () => {
  // requires_capability is a single predicate; compound AND gates belong in
  // requires_all_capabilities. A malformed gate (e.g. `requires_capability:
  // { all: [...] }`) crashes the runner before any step executes.
  const sourceRoot = path.join(__dirname, '..', 'static', 'compliance', 'source');
  const matchers = ['equals', 'contains', 'not_contains', 'present'];
  const problems = [];
  const checkPredicate = (predicate, where) => {
    if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) {
      problems.push(`${where}: predicate must be an object`);
      return;
    }
    if (typeof predicate.path !== 'string' || predicate.path.length === 0) {
      problems.push(`${where}: predicate is missing a string \`path\``);
    }
    const declared = matchers.filter(key => key in predicate);
    if (declared.length !== 1) {
      problems.push(`${where}: predicate must declare exactly one of ${matchers.join(', ')}`);
    }
  };
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.yaml')) continue;
      const doc = YAML.parse(fs.readFileSync(full, 'utf8'));
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) continue;
      const rel = path.relative(sourceRoot, full);
      if (doc.requires_capability !== undefined) {
        checkPredicate(doc.requires_capability, `${rel} requires_capability`);
      }
      if (doc.requires_all_capabilities !== undefined) {
        if (!Array.isArray(doc.requires_all_capabilities) || doc.requires_all_capabilities.length < 2) {
          problems.push(`${rel} requires_all_capabilities: must be an array of at least two predicates`);
        } else {
          doc.requires_all_capabilities.forEach((predicate, index) =>
            checkPredicate(predicate, `${rel} requires_all_capabilities[${index}]`));
        }
      }
      for (const phase of doc.phases) {
        if (phase && phase.requires_capability !== undefined) {
          checkPredicate(phase.requires_capability, `${rel} phase ${phase.id} requires_capability`);
        }
      }
    }
  };
  walk(sourceRoot);
  assert.deepEqual(problems, []);
});

// Execute the source baseline through the installed runner, including its response
// schemas and upstream checks. Capability differences must not strand the buy ID.
async function runNonGuaranteedLifecycle({ status, hasCreativeLibrary, pacingStatus = status, upstream = true, badContext = false }) {
  const storyboard = parseStoryboard(fs.readFileSync(path.join(
    __dirname, '..', 'static', 'compliance', 'source', 'specialisms', 'sales-non-guaranteed', 'index.yaml'
  ), 'utf8'));
  const phases = storyboard.phases.filter(phase => ['create_buy', 'monitor_pacing', 'adjust_bids'].includes(phase.id));
  const tools = ['get_adcp_capabilities', 'get_products', 'create_media_buy', 'get_media_buys', 'update_media_buy', 'comply_test_controller'];
  const requests = [];
  const packages = [
    { package_id: 'package-first', product_id: 'product-first', pricing_option_id: 'pricing-first', bid_price: 2, budget: 10000 },
    { package_id: 'package-second', product_id: 'product-second', pricing_option_id: 'pricing-second', bid_price: 3, budget: 15000 },
  ];
  const confirmedAt = '2026-01-01T00:00:00Z';
  const result = await runStoryboard('https://seller.example/mcp', {
    ...storyboard, prerequisites: undefined, fixtures: undefined, fixture_resolution: undefined, phases,
  }, {
    _profile: { tools, raw_capabilities: { creative: { has_creative_library: hasCreativeLibrary } } },
    _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
    agentTools: tools,
    context: {
      first_product_id: 'product-first', second_product_id: 'product-second',
      first_pricing_option_id: 'pricing-first', second_pricing_option_id: 'pricing-second',
      first_bid_price: 2, second_bid_price: 3,
      first_updated_bid_price: 4, second_updated_bid_price: 5,
    },
    _client: {
      resetContext() {},
      async createMediaBuy(request) {
        requests.push({ task: 'create_media_buy', request });
        return { success: true, data: {
          media_buy_id: 'buy-lifecycle', media_buy_status: status, confirmed_at: confirmedAt,
          revision: 1, packages, context: badContext ? { correlation_id: 'wrong' } : request.context,
        } };
      },
      async getMediaBuys(request) {
        requests.push({ task: 'get_media_buys', request });
        return { success: true, data: {
          media_buys: [{ media_buy_id: 'buy-lifecycle', status: pacingStatus, confirmed_at: confirmedAt,
            revision: 1, currency: 'USD', total_budget: 25000, packages }], context: request.context,
        } };
      },
      async updateMediaBuy(request) {
        requests.push({ task: 'update_media_buy', request });
        return { success: true, data: {
          media_buy_id: request.media_buy_id, media_buy_status: status, revision: 2,
          affected_packages: packages.map((pkg, index) => ({ ...pkg, ...request.packages[index] })),
          context: request.context,
        } };
      },
      async executeTask(task, request) {
        assert.equal(task, 'comply_test_controller');
        assert.equal(request.scenario, 'query_upstream_traffic');
        return { success: true, data: { success: true, recorded_calls: upstream ? [{
          timestamp: new Date().toISOString(), endpoint: 'POST https://auction.example/campaigns',
        }] : [] } };
      },
    },
  });
  return { result, requests, steps: result.phases.flatMap(phase => phase.steps) };
}

for (const [status, hasCreativeLibrary] of [['active', false], ['pending_creatives', true]]) {
  test(`non-guaranteed ${status} buy reaches pacing and bid updates`, async () => {
    const { result, requests, steps } = await runNonGuaranteedLifecycle({ status, hasCreativeLibrary });
    assert.equal(result.overall_passed, true, JSON.stringify(steps));
    assert.equal(steps.length, 3);
    assert.ok(steps.every(step => step.passed && !step.skipped), JSON.stringify(steps));
    assert.deepEqual(requests.map(entry => entry.task), ['create_media_buy', 'get_media_buys', 'update_media_buy']);
    assert.deepEqual(requests[1].request.media_buy_ids, ['buy-lifecycle']);
    assert.equal(requests[2].request.media_buy_id, 'buy-lifecycle');
    assert.deepEqual(requests[2].request.packages.map(pkg => pkg.package_id), ['package-first', 'package-second']);
    const upstreamChecks = steps.flatMap(step => step.validations).filter(check => check.check === 'upstream_traffic');
    assert.equal(upstreamChecks.length, 2);
    assert.ok(upstreamChecks.every(check => check.passed && !check.not_applicable));
  });
}

test('non-guaranteed lifecycle checks reject other states at creation and pacing', async () => {
  for (const status of ['pending_approval', 'rejected', 'canceled', 'completed']) {
    const created = await runNonGuaranteedLifecycle({ status, hasCreativeLibrary: false });
    assert.equal(created.steps[0].passed, false, status);
    assert.ok(created.steps[0].validations.some(check => check.path === 'media_buy_status' && !check.passed), status);
    const paced = await runNonGuaranteedLifecycle({ status: 'active', pacingStatus: status, hasCreativeLibrary: false });
    const pacing = paced.steps.find(step => step.step_id === 'get_media_buys_pacing');
    assert.equal(pacing.passed, false, status);
    assert.ok(pacing.validations.some(check => check.path === 'media_buys[0].status' && !check.passed), status);
  }
});

test('accepting active does not bypass context echoes or upstream side effects', async () => {
  for (const override of [{ upstream: false }, { badContext: true }]) {
    const { result, steps } = await runNonGuaranteedLifecycle({ status: 'active', hasCreativeLibrary: false, ...override });
    assert.equal(result.overall_passed, false);
    assert.equal(steps[0].passed, false);
    assert.ok(steps[0].validations.some(check => !check.passed && (
      override.badContext ? check.path === 'context.correlation_id' : check.check === 'upstream_traffic'
    )), JSON.stringify(steps[0].validations));
  }
});

function signalErrorComplianceSelection(t, marketplace) {
  // Copy real authored bundles into a cache matching the installed SDK's schema
  // version. No generated/released cache or installed SDK file is modified.
  const source = path.join(__dirname, '..', 'static/compliance/source');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-error-compliance-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cache, 'universal'), { recursive: true });
  fs.copyFileSync(
    path.join(source, 'universal/error-compliance-signals.yaml'),
    path.join(cache, 'universal/error-compliance-signals.yaml'),
  );
  for (const relative of ['protocols/signals', 'specialisms/signal-owned', 'specialisms/signal-marketplace']) {
    fs.cpSync(path.join(source, relative), path.join(cache, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(cache, 'index.json'), JSON.stringify({
    adcp_version: require('@adcp/sdk').ADCP_VERSION,
    generated_at: '2026-10-29T00:00:00Z',
    universal: ['error-compliance-signals'],
    protocols: [{ id: 'signals', title: 'Signals', has_baseline: true, path: 'protocols/signals' }],
    specialisms: ['signal-owned', 'signal-marketplace'].map(id => ({
      id, protocol: 'signals', title: id, status: 'stable', path: `specialisms/${id}`,
    })),
  }));
  const capabilities = { supported_protocols: ['signals'], specialisms: [marketplace ? 'signal-marketplace' : 'signal-owned'] };
  const options = { complianceDir: cache };
  const resolved = resolveStoryboardsForCapabilities(capabilities, options);
  return { capabilities, options, resolved };
}

async function runSignalErrorEvidence(storyboard, {
  marketplace = false,
  activation = marketplace,
  controller = true,
  discovery = true,
  fault,
} = {}) {
  const tools = [
    'get_adcp_capabilities',
    ...(discovery ? ['get_signals'] : []),
    ...(activation ? ['activate_signal'] : []),
    ...(controller ? ['comply_test_controller'] : []),
  ];
  const capabilities = {
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['signals'],
    specialisms: [marketplace ? 'signal-marketplace' : 'signal-owned'],
  };
  const calls = [];
  const rejection = (request, code) => ({
    success: false,
    data: {
      status: 'failed',
      errors: [{ code, message: 'Fixture rejection', recovery: 'correctable' }],
      ...(fault !== 'missing-context' && { context: request.context }),
    },
  });
  const success = request => ({
    success: true,
    data: { status: 'completed', signals: [], cache_scope: 'account', context: request.context },
  });
  const runOptions = applyStoryboardVersionOptions(storyboard, {
    _profile: { tools, raw_capabilities: capabilities },
    agentTools: tools,
    skip_controller_seeding: true,
    test_kit: YAML.parse(fs.readFileSync(path.join(__dirname, '../static/compliance/source/test-kits/nova-motors.yaml'), 'utf8')),
  });
  // Keep the SDK's version metadata on the official client instance so the
  // version-annotated resolver output reuses this isolated test client.
  runOptions._client = Object.assign(createTestClient('https://agent.example/mcp', 'mcp', runOptions), {
      resetContext() {},
      async getAdcpCapabilities(request) {
        calls.push({ task: 'get_adcp_capabilities', request });
        return { success: true, data: { ...capabilities, context: request.context } };
      },
      async getSignals(request, _context, options) {
        calls.push({ task: 'get_signals', request, options });
        if (request.adcp_major_version === 99) return rejection(request, 'VERSION_UNSUPPORTED');
        if (typeof request.signal_spec !== 'string') {
          if (fault === 'accept-invalid-discovery') return success(request);
          return rejection(request, fault === 'wrong-code' ? 'ACCOUNT_SETUP_REQUIRED' : 'INVALID_REQUEST');
        }
        return success(request);
      },
      async activateSignal(request, _context, options) {
        calls.push({ task: 'activate_signal', request, options });
        const missing = request.signal_agent_segment_id === undefined;
        if (fault === (missing ? 'accept-missing-segment' : 'accept-unknown-segment')) return success(request);
        return rejection(request, missing ? 'INVALID_REQUEST' : 'REFERENCE_NOT_FOUND');
      },
  });
  const result = await runStoryboard('https://agent.example/mcp', storyboard, runOptions);
  return { result, calls };
}

test('signals error evidence follows the actual owned/marketplace bundle selection', t => {
  const owned = signalErrorComplianceSelection(t, false);
  assert.ok(owned.resolved.storyboards.some(storyboard => storyboard.id === 'error_compliance_signals'));
  assert.ok(!owned.resolved.storyboards.some(storyboard => storyboard.id === 'signal_marketplace/error_compliance'));

  const marketplace = signalErrorComplianceSelection(t, true);
  assert.ok(marketplace.resolved.storyboards.some(storyboard => storyboard.id === 'signal_marketplace/error_compliance'));
  const index = marketplace.resolved.storyboards.find(storyboard => storyboard.id === 'signal_marketplace');
  assert.ok(index.requires_scenarios.includes('signal_marketplace/error_compliance'));
  assert.deepEqual(
    resolveBundleOrStoryboard('signal_marketplace/error_compliance', marketplace.options).map(storyboard => storyboard.id),
    ['signal_marketplace/error_compliance'],
  );
});

test('signals discovery error bundle passes for both models without requiring activation', async t => {
  for (const [marketplace, activation] of [[false, false], [true, true], [false, true]]) {
    const { resolved } = signalErrorComplianceSelection(t, marketplace);
    const bundle = resolved.bundles.find(entry => entry.ref.id === 'error-compliance-signals');
    const storyboard = bundle.storyboards[0];
    const { result, calls } = await runSignalErrorEvidence(storyboard, { marketplace, activation });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(result.passed_count, 5);
    assert.equal(result.skipped_count, 0);
    assert.equal(buildComplianceBundleResults([bundle], [result])[0].status, 'passing');
    assert.ok(!calls.some(call => call.task === 'activate_signal'));
    const malformed = calls.filter(call => call.task === 'get_signals' && call.request.signal_spec === 123);
    assert.equal(malformed.length, 2, 'both authored error probes reach discovery with wrong-typed input');
    assert.ok(malformed.every(call => call.options?.skipRequestValidation === true));
    // An owned agent exposing optional activation still claims only owned
    // coverage: selection does not silently imply marketplace conformance.
    if (!marketplace) {
      assert.ok(!resolved.storyboards.some(entry => entry.id === 'signal_marketplace/error_compliance'));
    }
  }
});

test('signals discovery errors preserve failures and missing required evidence', async t => {
  const { resolved } = signalErrorComplianceSelection(t, false);
  const bundle = resolved.bundles.find(entry => entry.ref.id === 'error-compliance-signals');
  for (const fault of ['accept-invalid-discovery', 'wrong-code', 'missing-context']) {
    const { result } = await runSignalErrorEvidence(bundle.storyboards[0], { fault });
    assert.equal(buildComplianceBundleResults([bundle], [result])[0].status, 'failing', fault);
    assert.ok(result.failed_count > 0);
  }
  for (const unavailable of [{ discovery: false }, { controller: false }]) {
    const { result, calls } = await runSignalErrorEvidence(bundle.storyboards[0], unavailable);
    assert.equal(buildComplianceBundleResults([bundle], [result])[0].status, 'partial');
    assert.ok(!calls.some(call => call.task === 'get_signals'));
  }
});

test('marketplace activation errors execute both negatives and cap the real bundle on failure or gaps', async t => {
  const { resolved } = signalErrorComplianceSelection(t, true);
  const bundle = resolved.bundles.find(entry => entry.ref.id === 'signal-marketplace');
  const storyboard = bundle.storyboards.find(entry => entry.id === 'signal_marketplace/error_compliance');
  const { result, calls } = await runSignalErrorEvidence(storyboard, { marketplace: true });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.passed_count, 2);
  assert.equal(result.skipped_count, 0);
  assert.equal(calls.filter(call => call.task === 'activate_signal').length, 2);
  assert.equal(calls.find(call => call.request.signal_agent_segment_id === undefined).options.skipRequestValidation, true);
  assert.notEqual(calls.find(call => call.request.signal_agent_segment_id !== undefined).options?.skipRequestValidation, true);
  // Other marketplace flows have not run in this focused regression. Keep
  // them incomplete rather than fabricating sibling passes to credit a role.
  assert.equal(buildComplianceBundleResults([bundle], [result])[0].status, 'partial');
  for (const fault of ['accept-unknown-segment', 'accept-missing-segment']) {
    const broken = await runSignalErrorEvidence(storyboard, { marketplace: true, fault });
    assert.equal(buildComplianceBundleResults([bundle], [broken.result])[0].status, 'failing', fault);
  }
  for (const unavailable of [{ activation: false }, { controller: false }]) {
    const missing = await runSignalErrorEvidence(storyboard, { marketplace: true, ...unavailable });
    assert.equal(buildComplianceBundleResults([bundle], [missing.result])[0].status, 'partial');
    assert.equal(missing.calls.length, 0);
  }
});
