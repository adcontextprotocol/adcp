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

    const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
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

test('creative fate storyboard requires advertised creative library support', async () => {
  const storyboardPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'protocols',
    'media-buy',
    'scenarios',
    'creative_fate_after_cancellation.yaml'
  );
  const storyboard = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
  const tools = ['get_adcp_capabilities', ...storyboard.required_tools];

  assert.deepEqual(storyboard.requires_capability, {
    path: 'creative.has_creative_library',
    equals: true,
  });

  const unsupportedProfiles = [
    {
      rawCapabilities: { creative: { has_creative_library: false } },
      errorPattern: /creative\.has_creative_library/,
    },
    {
      rawCapabilities: {},
      errorPattern: /agent did not declare support/,
    },
  ];

  for (const { rawCapabilities, errorPattern } of unsupportedProfiles) {
    const result = await runStoryboard('https://agent.example/mcp', storyboard, {
      _profile: { tools, raw_capabilities: rawCapabilities },
      agentTools: tools,
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].phase_id, 'capability_unsupported');
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
    assert.match(result.phases[0].steps[0].error, errorPattern);
  }

  const supported = await runStoryboard(
    'https://agent.example/mcp',
    { ...storyboard, prerequisites: undefined, phases: [] },
    {
      _profile: {
        tools,
        raw_capabilities: { creative: { has_creative_library: true } },
      },
      agentTools: tools,
    }
  );

  assert.equal(supported.overall_passed, true);
  assert.equal(supported.phases[0].phase_id, 'no_phases');
  assert.equal(supported.phases[0].steps[0].skip_reason, 'no_phases');
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
  const tools = ['get_adcp_capabilities', 'create_media_buy'];
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

test('billing gate skips per-agent phases when agent billing is not supported', () => {
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

    const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
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
    ['sales_guaranteed/delivery_monitoring', ['confirm_active']],
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

  const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
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

  const tools = ['get_adcp_capabilities', ...accepted.required_tools];
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
