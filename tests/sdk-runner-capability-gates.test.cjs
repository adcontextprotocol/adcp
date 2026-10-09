#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { runStoryboard } = require('@adcp/sdk/testing');

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

test('billing gate skips phases when account capabilities are absent', async () => {
  const storyboardPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'universal',
    'billing-gate-dispatch.yaml'
  );
  const storyboard = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
  const perAgentPhases = storyboard.phases.filter(phase => phase.id.startsWith('per_agent_gate_'));
  const capabilityDiscovery = storyboard.phases.find(phase => phase.id === 'capability_discovery');

  assert.deepEqual(
    {
      optional: capabilityDiscovery.optional,
      requires_capability: capabilityDiscovery.requires_capability,
    },
    {
      optional: true,
      requires_capability: { path: 'account', present: true },
    }
  );

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

test('advanced delivery reporting dispatches wholesale discovery only to opted-in sellers', async () => {
  const storyboard = loadMediaBuyStoryboard('advanced_delivery_reporting');
  const discovery = storyboard.phases[0].steps.find(step => step.id === 'discover_product');
  const executable = {
    ...storyboard,
    prerequisites: undefined,
    fixtures: undefined,
    phases: [{
      ...storyboard.phases[0],
      steps: [{ ...discovery, context_outputs: [], validations: [] }],
    }],
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
      agentTools: tools,
      _client: {
        resetContext() {},
        async getProducts(request) {
          requests.push(request);
          return { success: true, data: { products: [] } };
        },
      },
    });

    assert.equal(result.overall_passed, true);
    if (buyingModes?.includes('wholesale')) {
      assert.equal(requests.length, 1);
      assert.equal(requests[0].buying_mode, 'wholesale');
      assert.equal(result.passed_count, 1);
    } else {
      assert.deepEqual(requests, []);
      assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
      assert.equal(result.passed_count, 0);
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
