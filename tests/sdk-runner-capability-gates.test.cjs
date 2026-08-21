#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { runStoryboard } = require('@adcp/sdk/testing');

const mediaBuyScenarioRoot = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'protocols',
  'media-buy',
  'scenarios'
);

function loadMediaBuyScenario(name) {
  return YAML.parse(
    fs.readFileSync(path.join(mediaBuyScenarioRoot, `${name}.yaml`), 'utf8')
  );
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

test('inventory-list storyboards skip sellers that declare legacy property-list support false', async () => {
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
      path: 'media_buy.features.property_list_filtering',
      equals: true,
    });

    const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
    const result = await runStoryboard('https://agent.example/mcp', storyboard, {
      _profile: {
        tools,
        raw_capabilities: {
          media_buy: { features: { property_list_filtering: false } },
        },
      },
      agentTools: tools,
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.phases[0].phase_id, 'capability_unsupported');
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
    assert.match(result.phases[0].steps[0].error, /property_list_filtering/);
  }
});

test('inventory-list no-match preserves both stable-line outcomes', () => {
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
  const storyboard = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
  const outcomePhases = storyboard.phases.filter(phase => phase.branch_set?.id === 'property_list_no_match_handled');

  assert.equal(outcomePhases.length, 2);
  assert.ok(outcomePhases.every(phase => phase.optional === true));
  assert.ok(outcomePhases.every(phase => phase.branch_set.semantics === 'any_of'));
  assert.deepEqual(
    outcomePhases.map(phase => phase.steps[0].expect_error === true),
    [false, true]
  );
});

test('inventory-list no-match runner accepts either stable-line outcome', async () => {
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
  const storyboard = {
    ...source,
    prerequisites: undefined,
    phases: source.phases.slice(1).map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({
        ...step,
        validations: step.validations?.filter(validation => validation.check !== 'response_schema'),
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
        media_buy: { features: { property_list_filtering: true } },
      },
    },
  };

  const accepted = await runStoryboard('https://agent.example/mcp', storyboard, {
    ...baseOptions,
    _client: {
      resetContext() {},
      async createMediaBuy(request) {
        return {
          success: true,
          data: {
            media_buy_id: 'zero-delivery-buy',
            packages: [{ targeting_overlay: request.packages[0].targeting_overlay }],
            context: request.context,
          },
        };
      },
    },
  });
  assert.equal(accepted.overall_passed, true);

  const rejected = await runStoryboard('https://agent.example/mcp', storyboard, {
    ...baseOptions,
    _client: {
      resetContext() {},
      async createMediaBuy(request) {
        return {
          success: false,
          data: {
            errors: [{ code: 'PRODUCT_UNAVAILABLE', message: 'No matching inventory' }],
            context: request.context,
          },
        };
      },
    },
  });
  assert.equal(rejected.overall_passed, true);
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

test('creative-dependent seller scenarios fail closed for library-less sellers', async () => {
  for (const name of [
    'pending_creatives_to_start',
    'creative_fate_after_cancellation',
    'dependency_impairment',
    'dependency_impairment_cardinality',
  ]) {
    const storyboard = loadMediaBuyScenario(name);
    assert.deepEqual(storyboard.requires_capability, {
      path: 'creative.has_creative_library',
      equals: true,
    });

    const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
    const result = await runStoryboard('https://agent.example/mcp', storyboard, {
      _profile: {
        tools,
        raw_capabilities: { creative: { has_creative_library: false } },
      },
      agentTools: tools,
    });

    assert.equal(result.overall_passed, true, name);
    assert.equal(result.skipped_count, 1, name);
    assert.equal(result.phases[0].phase_id, 'capability_unsupported', name);
    assert.match(result.phases[0].steps[0].error, /creative\.has_creative_library/, name);
  }
});

test('3.1 compound applicability remains enforced through phase gates', () => {
  const expected = new Map([
    ['pending_creatives_to_start', {
      path: 'media_buy.creative_approval_mode',
      equals: 'auto_approve',
    }],
    ['dependency_impairment', {
      path: 'media_buy.propagation_surfaces',
      contains: 'snapshot',
    }],
    ['dependency_impairment_cardinality', {
      path: 'media_buy.propagation_surfaces',
      contains: 'snapshot',
    }],
  ]);

  for (const [name, gate] of expected) {
    const storyboard = loadMediaBuyScenario(name);
    assert.ok(storyboard.phases.length > 0, name);
    for (const phase of storyboard.phases) {
      assert.deepEqual(phase.requires_capability, gate, `${name}/${phase.id}`);
    }
  }
});

test('3.1 scopes refinement and keeps only universal measurement rejection', async () => {
  const refinement = loadMediaBuyScenario('refine_products');
  assert.deepEqual(refinement.requires_capability, {
    path: 'media_buy.buying_modes',
    contains: 'refine',
  });

  const tools = ['get_adcp_capabilities', ...refinement.required_tools];
  const result = await runStoryboard('https://agent.example/mcp', refinement, {
    _profile: {
      tools,
      raw_capabilities: { media_buy: { buying_modes: ['brief'] } },
    },
    agentTools: tools,
  });
  assert.equal(result.overall_passed, true);
  assert.equal(result.phases[0].phase_id, 'capability_unsupported');

  const measurement = loadMediaBuyScenario('measurement_terms_rejected');
  assert.deepEqual(measurement.phases.map(phase => phase.id), [
    'discover_products',
    'reject_terms',
  ]);
});

test('direct creative-sync phases have authoritative library gates', () => {
  const sourceRoot = path.join(__dirname, '..', 'static', 'compliance', 'source');
  const indexPaths = [
    path.join(sourceRoot, 'protocols', 'media-buy', 'index.yaml'),
    ...['sales-broadcast-tv', 'sales-guaranteed', 'sales-proposal-mode'].map(name =>
      path.join(sourceRoot, 'specialisms', name, 'index.yaml')
    ),
  ];

  for (const indexPath of indexPaths) {
    const index = YAML.parse(fs.readFileSync(indexPath, 'utf8'));
    const phase = index.phases.find(candidate => candidate.id === 'creative_sync');
    assert.deepEqual(phase.requires_capability, {
      path: 'creative.has_creative_library',
      equals: true,
    }, index.id);
  }
});

test('library-less sellers still execute delivery from the create-buy anchor', async () => {
  const indexPath = path.join(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'protocols',
    'media-buy',
    'index.yaml'
  );
  const source = YAML.parse(fs.readFileSync(indexPath, 'utf8'));
  const sourcePhases = new Map(source.phases.map(phase => [phase.id, phase]));
  const creativeSource = sourcePhases.get('creative_sync');
  const deliverySource = sourcePhases.get('delivery_monitoring');

  assert.deepEqual(deliverySource.depends_on, ['create_buy']);

  const storyboard = {
    id: 'libraryless_delivery_anchor_regression',
    version: '1.0.0',
    title: 'Library-less delivery anchor regression',
    category: 'media_buy_seller',
    summary: 'Regression',
    narrative: 'Regression',
    agent: { interaction_model: 'media_buy_seller', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'create_buy',
        title: 'Create buy',
        steps: [{
          id: 'create_state',
          title: 'Create state',
          task: 'get_products',
          stateful: true,
          sample_request: { brief: 'create state' },
        }],
      },
      {
        id: creativeSource.id,
        title: creativeSource.title,
        requires_capability: creativeSource.requires_capability,
        steps: [{
          id: 'creative_state',
          title: 'Creative state',
          task: 'sync_creatives',
          stateful: true,
          sample_request: { creatives: [] },
        }],
      },
      {
        id: deliverySource.id,
        title: deliverySource.title,
        depends_on: deliverySource.depends_on,
        steps: [{
          id: 'delivery_state',
          title: 'Delivery state',
          task: 'get_products',
          stateful: true,
          sample_request: { brief: 'delivery state' },
        }],
      },
    ],
  };

  let getProductsCalls = 0;
  const tools = ['get_adcp_capabilities', 'get_products', 'sync_creatives'];
  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    _profile: {
      tools,
      raw_capabilities: { creative: { has_creative_library: false } },
    },
    agentTools: tools,
    _client: {
      resetContext() {},
      async getProducts() {
        getProductsCalls++;
        return { success: true, data: { products: [] } };
      },
    },
  });

  assert.equal(result.overall_passed, true);
  assert.equal(getProductsCalls, 2);
  const creativeResult = result.phases.find(phase => phase.phase_id === 'creative_sync');
  const deliveryResult = result.phases.find(phase => phase.phase_id === 'delivery_monitoring');
  assert.equal(creativeResult.steps[0].skip_reason, 'not_applicable');
  assert.notEqual(deliveryResult.steps[0].skipped, true);
  assert.equal(deliveryResult.steps[0].passed, true);
});
