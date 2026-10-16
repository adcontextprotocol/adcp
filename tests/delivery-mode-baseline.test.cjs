#!/usr/bin/env node
'use strict';

/**
 * media_buy.supported_delivery_types and the delivery-mode-aware media-buy
 * baseline (adcp#7852).
 *
 * Contract under test:
 *   - the capability is optional and defaults to both delivery modes;
 *   - media_buy_seller and every inherited scenario that creates buys on
 *     non-guaranteed (or discovered) inventory is gated on `non_guaranteed`;
 *   - media_buy_seller_guaranteed runs only for sellers that declare a set
 *     without `non_guaranteed`;
 *   - a seller that declares nothing sees no change.
 *
 * Requires `npm run build:schemas`: the runner resolves the schema default
 * for an undeclared seller from the built schema root.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { runStoryboard } = require('@adcp/sdk/testing');

const ROOT = path.join(__dirname, '..');
const PROTOCOL_DIR = path.join(ROOT, 'static', 'compliance', 'source', 'protocols', 'media-buy');
const SCHEMA_ROOT = path.join(ROOT, 'dist', 'schemas', 'latest');
const BUILT_CAPABILITIES_SCHEMA = path.join(SCHEMA_ROOT, 'protocol', 'get-adcp-capabilities-response.json');
const CAPABILITIES_SCHEMA = path.join(
  ROOT, 'static', 'schemas', 'source', 'protocol', 'get-adcp-capabilities-response.json'
);

const NON_GUARANTEED_GATE = { path: 'media_buy.supported_delivery_types', contains: 'non_guaranteed' };
const GUARANTEED_ONLY_GATE = { path: 'media_buy.supported_delivery_types', not_contains: 'non_guaranteed' };

/**
 * Inherited scenarios that create a buy and are intentionally NOT gated. Every
 * entry needs a reviewed reason; adding one is a decision, not a convenience.
 */
const UNGATED_CREATE_SCENARIO_ALLOWLIST = new Map([
  [
    'media_buy_seller/measurement_terms_rejected',
    'Asserts TERMS_REJECTED on the create response. A guaranteed-only seller rejects terms before it '
      + 'defers the buy to an IO, so the check is delivery-mode-independent (graded clean for a '
      + 'guaranteed-only training seller).',
  ],
]);

function loadByIdFromProtocolDir() {
  const byId = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.yaml')) {
        const doc = YAML.parse(fs.readFileSync(full, 'utf8'));
        if (doc && doc.id) byId.set(doc.id, doc);
      }
    }
  };
  walk(PROTOCOL_DIR);
  return byId;
}

function predicatesOf(storyboard) {
  return [
    ...(storyboard.requires_capability ? [storyboard.requires_capability] : []),
    ...(storyboard.requires_all_capabilities ?? []),
  ];
}

function hasGate(storyboard, gate) {
  return predicatesOf(storyboard).some(p => JSON.stringify(p) === JSON.stringify(gate));
}

function createsMediaBuy(storyboard) {
  return (storyboard.phases ?? []).some(phase =>
    (phase.steps ?? []).some(step => step.task === 'create_media_buy'));
}

function declaresGuaranteedFixture(storyboard) {
  return (storyboard.fixtures?.products ?? []).some(product => product.delivery_type === 'guaranteed');
}

test('supported_delivery_types is optional, bounded, and defaults to both modes', () => {
  const schema = JSON.parse(fs.readFileSync(CAPABILITIES_SCHEMA, 'utf8'));
  const field = schema.properties.media_buy.properties.supported_delivery_types;
  assert.equal(field.type, 'array');
  assert.deepEqual(field.items, { $ref: '/schemas/enums/delivery-type.json' });
  assert.equal(field.minItems, 1);
  assert.equal(field.uniqueItems, true);
  assert.deepEqual(field.default, ['guaranteed', 'non_guaranteed']);
  assert.ok(!(schema.properties.media_buy.required ?? []).includes('supported_delivery_types'));
  assert.match(field.description, /UNSUPPORTED_FEATURE/);
});

test('base baseline is gated on non_guaranteed and the guaranteed baseline on its absence', () => {
  const byId = loadByIdFromProtocolDir();
  const base = byId.get('media_buy_seller');
  const guaranteed = byId.get('media_buy_seller_guaranteed');
  assert.ok(base && guaranteed, 'both baselines load from the media-buy protocol directory');
  assert.deepEqual(base.requires_capability, NON_GUARANTEED_GATE);
  assert.deepEqual(guaranteed.requires_capability, GUARANTEED_ONLY_GATE);
  assert.equal(guaranteed.requires_all_capabilities, undefined);
  assert.ok(
    !base.requires_scenarios.includes('media_buy_seller_guaranteed'),
    'the guaranteed baseline is a sibling baseline, not an inherited scenario'
  );
  // The new baseline reuses the proven guaranteed lifecycle and must keep the
  // missing-controller coverage-gap wording.
  assert.match(guaranteed.narrative, /missing_test_controller/);
  assert.deepEqual(guaranteed.requires, ['controller']);
  assert.match(guaranteed.narrative, /not a complete grade/);
  for (const stepId of ['get_products_unfiltered', 'get_products_non_guaranteed_empty', 'force_submitted_buy', 'create_media_buy', 'get_submitted_task', 'force_task_completion', 'get_completed_task']) {
    const found = guaranteed.phases.flatMap(p => p.steps).some(step => step.id === stepId);
    assert.ok(found, `guaranteed baseline carries step ${stepId}`);
  }
});

test('every inherited scenario that creates buys on non-guaranteed inventory is gated or reviewed', () => {
  const byId = loadByIdFromProtocolDir();
  const base = byId.get('media_buy_seller');
  const problems = [];
  for (const id of base.requires_scenarios) {
    const scenario = byId.get(id);
    if (!scenario || !createsMediaBuy(scenario)) continue;
    if (declaresGuaranteedFixture(scenario)) continue; // guaranteed or mixed flow
    if (hasGate(scenario, NON_GUARANTEED_GATE)) continue;
    if (UNGATED_CREATE_SCENARIO_ALLOWLIST.has(id)) continue;
    problems.push(
      `${id} creates buys without a guaranteed fixture; add requires_capability `
      + '{ path: media_buy.supported_delivery_types, contains: non_guaranteed } '
      + '(use requires_all_capabilities when it already has a gate) or add a reviewed allowlist entry'
    );
  }
  assert.deepEqual(problems, []);
  for (const id of UNGATED_CREATE_SCENARIO_ALLOWLIST.keys()) {
    const scenario = byId.get(id);
    assert.ok(scenario && base.requires_scenarios.includes(id) && createsMediaBuy(scenario),
      `stale allowlist entry ${id}`);
    assert.ok(!hasGate(scenario, NON_GUARANTEED_GATE), `${id} is gated; drop the allowlist entry`);
  }
});

test('edited storyboards carry both gate predicates through requires_all_capabilities', () => {
  const byId = loadByIdFromProtocolDir();
  for (const [id, scenario] of byId) {
    if (!hasGate(scenario, NON_GUARANTEED_GATE) || id === 'media_buy_seller') continue;
    if (scenario.requires_all_capabilities) {
      assert.ok(scenario.requires_all_capabilities.length >= 2, `${id}: compound gate needs two predicates`);
    }
    assert.ok(
      !(scenario.requires_capability && scenario.requires_all_capabilities),
      `${id}: use one gate form`
    );
  }
});

test('every added non_guaranteed gate is tagged TEMPORARY so it is removed with Option B', () => {
  const missing = [];
  let gates = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.yaml')) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/path: media_buy\.supported_delivery_types$/.test(line) || !/^\s*contains: non_guaranteed/.test(lines[index + 1] ?? '')) return;
        gates += 1;
        const above = /^\s*- path:/.test(line) ? lines[index - 1] : lines[index - 2];
        if (!/TEMPORARY\(adcp#7852\)/.test(above ?? '')) missing.push(`${path.relative(PROTOCOL_DIR, full)}:${index + 1}`);
      });
    }
  };
  walk(PROTOCOL_DIR);
  assert.ok(gates >= 38);
  assert.deepEqual(missing, []);
});

function walkYaml(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkYaml(full, visit);
    else if (entry.name.endsWith('.yaml')) visit(full, YAML.parse(fs.readFileSync(full, 'utf8')));
  }
}

function schemaNodeAt(schema, dottedPath) {
  let node = schema;
  for (const key of dottedPath.split('.')) {
    if (!node || !node.properties || !(key in node.properties)) return undefined;
    node = node.properties[key];
  }
  return node;
}

test('every value gate whose path has a source schema default resolves that default in the built schema', () => {
  // The runner resolves an absent capability from the default in the schema root it loads. A
  // bundle must therefore never ship paired with a schema root that lacks a default its gates
  // depend on: the gate would fail closed and grade the storyboard not_applicable.
  assert.ok(fs.existsSync(BUILT_CAPABILITIES_SCHEMA), 'run `npm run build:schemas` first');
  const source = JSON.parse(fs.readFileSync(CAPABILITIES_SCHEMA, 'utf8'));
  const built = JSON.parse(fs.readFileSync(BUILT_CAPABILITIES_SCHEMA, 'utf8'));
  const compliance = path.join(ROOT, 'static', 'compliance', 'source');
  const problems = [];
  let relied = 0;
  walkYaml(compliance, (file, doc) => {
    if (!doc || !Array.isArray(doc.phases)) return;
    const predicates = [
      ...predicatesOf(doc),
      ...doc.phases.flatMap(phase => (phase.requires_capability ? [phase.requires_capability] : [])),
    ];
    for (const predicate of predicates) {
      if ('present' in predicate) continue; // `present` never uses defaults
      const sourceNode = schemaNodeAt(source, predicate.path);
      if (!sourceNode || !('default' in sourceNode)) continue;
      relied += 1;
      const builtNode = schemaNodeAt(built, predicate.path);
      if (!builtNode || JSON.stringify(builtNode.default) !== JSON.stringify(sourceNode.default)) {
        problems.push(`${path.relative(compliance, file)}: ${predicate.path} default is missing from the built schema`);
      }
    }
  });
  assert.deepEqual(problems, []);
  assert.ok(relied > 30, `expected to find default-reliant gates, found ${relied}`);
  const delivery = schemaNodeAt(built, 'media_buy.supported_delivery_types');
  assert.deepEqual(delivery.default, ['guaranteed', 'non_guaranteed']);
});

/**
 * Run a storyboard with no phases against declared capabilities: the runner
 * evaluates the storyboard-level gate, then reports `capability_unsupported`
 * (not applicable) or `no_phases` (selected).
 */
async function gateOutcome(storyboard, rawCapabilities) {
  const tools = ['get_adcp_capabilities', 'comply_test_controller', ...(storyboard.required_tools ?? [])];
  const result = await runStoryboard(
    'https://agent.example/mcp',
    { ...storyboard, prerequisites: undefined, fixtures: undefined, phases: [] },
    {
      _profile: { tools, raw_capabilities: rawCapabilities },
      agentTools: tools,
      schemaRoot: SCHEMA_ROOT,
      adcpVersion: JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'index.json'), 'utf8')).adcp_version,
    }
  );
  assert.equal(result.failed_count, 0);
  const phase = result.phases[0].phase_id;
  assert.ok(phase === 'capability_unsupported' || phase === 'no_phases', `unexpected phase ${phase}`);
  return phase === 'no_phases' ? 'selected' : 'not_applicable';
}

test('gates select the right baseline per declaration, and an undeclared seller sees no change', async t => {
  assert.ok(
    fs.existsSync(path.join(SCHEMA_ROOT, 'index.json')),
    'run `npm run build:schemas` first: the undeclared default resolves from the built schema root'
  );
  const byId = loadByIdFromProtocolDir();
  const subjects = ['media_buy_seller', 'media_buy_seller/delivery_reporting', 'media_buy_seller_guaranteed']
    .map(id => [id, byId.get(id)]);

  const declarations = [
    // [label, media_buy capability object, [base selected, scenario selected, guaranteed baseline selected]]
    ['undeclared (no media_buy fields)', {}, ['selected', 'selected', 'not_applicable']],
    ['both declared', { supported_delivery_types: ['guaranteed', 'non_guaranteed'] }, ['selected', 'selected', 'not_applicable']],
    ['non_guaranteed only', { supported_delivery_types: ['non_guaranteed'] }, ['selected', 'selected', 'not_applicable']],
    ['guaranteed only', { supported_delivery_types: ['guaranteed'] }, ['not_applicable', 'not_applicable', 'selected']],
  ];
  for (const [label, mediaBuy, expected] of declarations) {
    await t.test(label, async () => {
      const outcomes = [];
      for (const [, storyboard] of subjects) outcomes.push(await gateOutcome(storyboard, { media_buy: mediaBuy }));
      assert.deepEqual(outcomes, expected);
    });
  }

  // Documented hazard: the runner resolves the schema default only when the `media_buy` object
  // exists. A seller that advertises the protocol with no `media_buy` block fails every
  // delivery-mode gate closed, so the base baseline is not applicable AND the guaranteed baseline
  // is not selected: neither baseline grades it. Sellers MUST emit a media_buy block; the SDK fix
  // (apply defaults when the parent is absent) is tracked separately. If this assertion starts
  // failing because the runner learned to apply the default, update the docs and the DR.
  await t.test('no media_buy block: fail-closed, neither baseline grades the seller', async () => {
    const outcomes = [];
    for (const [, storyboard] of subjects) {
      outcomes.push(await gateOutcome(storyboard, { supported_protocols: ['media_buy'] }));
    }
    assert.deepEqual(outcomes, ['not_applicable', 'not_applicable', 'not_applicable']);
  });

  // An undeclared seller must be indistinguishable from an explicit "both" on storyboards
  // whose only gate is the delivery-mode predicate. Each runner call is slow, so sample the
  // scenario kinds (no other gate, gate on creates, gate on discovery) rather than all of them.
  await t.test('undeclared equals both declared for delivery-mode-only gates', async () => {
    for (const id of [
      'media_buy_seller/total_budget_redistribution',
      'media_buy_seller/product_filter_behavior',
    ]) {
      const storyboard = byId.get(id);
      assert.deepEqual(predicatesOf(storyboard), [NON_GUARANTEED_GATE], id);
      const undeclared = await gateOutcome(storyboard, { media_buy: {} });
      const both = await gateOutcome(storyboard, {
        media_buy: { supported_delivery_types: ['guaranteed', 'non_guaranteed'] },
      });
      assert.equal(undeclared, 'selected', id);
      assert.equal(both, 'selected', id);
    }
  });
});

test('a missing approval controller grades one storyboard-level missing_test_controller skip, not a failure or missing_tool', async () => {
  const guaranteed = loadByIdFromProtocolDir().get('media_buy_seller_guaranteed');
  assert.ok(!guaranteed.required_tools.includes('comply_test_controller'));
  const forced = guaranteed.phases.flatMap(p => p.steps).filter(step => step.task === 'comply_test_controller');
  assert.ok(forced.length >= 2);
  for (const step of forced) assert.equal(step.requires_tool, 'comply_test_controller', step.id);

  const tools = ['get_adcp_capabilities', 'get_products', 'create_media_buy', 'get_task_status', 'get_media_buys', 'get_media_buy_delivery'];
  const result = await runStoryboard('https://agent.example/mcp', { ...guaranteed, prerequisites: undefined, fixtures: undefined }, {
    _profile: {
      tools,
      raw_capabilities: { media_buy: { supported_delivery_types: ['guaranteed'] } },
    },
    agentTools: tools,
    schemaRoot: SCHEMA_ROOT,
    adcpVersion: JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'index.json'), 'utf8')).adcp_version,
    _client: new Proxy({}, {
      get(_target, name) {
        if (name === 'resetContext') return () => {};
        return async () => ({ success: false, error: 'mock transport' });
      },
    }),
  });
  assert.equal(result.failed_count, 0);
  assert.equal(result.overall_passed, true);
  assert.equal(result.passed_count, 0);
  const steps = result.phases.flatMap(phase => phase.steps);
  assert.ok(steps.length >= 1 && steps.every(step => step.skipped));
  assert.ok(steps.every(step => step.skip_reason === 'missing_test_controller'),
    JSON.stringify(steps.map(step => [step.skip_reason, step.skip?.reason])));
});
