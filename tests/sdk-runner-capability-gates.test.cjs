#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { runStoryboard } = require('@adcp/sdk/testing');

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
