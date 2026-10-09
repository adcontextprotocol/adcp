#!/usr/bin/env node
/**
 * Tests for the buyer-fixture lifecycle-tools lint. Two concerns:
 *   1. Source-tree guard — every real buyer storyboard advertises only the
 *      compact lifecycle tools the fixture-publisher contract serves.
 *   2. Per-rule coverage against synthetic source trees.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const {
  lint,
  PENDING_STORYBOARDS,
  RULE_MESSAGES,
  walkLifecycleTools,
} = require('../scripts/lint-storyboard-buyer-fixture-lifecycle-tools.cjs');

const SOURCE_ROOT = path.join(__dirname, '..', 'static', 'compliance', 'source');

const CONTRACT = `
id: buyer_fixture_publisher
tool_handlers:
  get_adcp_capabilities: {}
  get_products: {}
  list_products: {}
  create_media_buy: {}
authoring_rules:
  lifecycle_tools_constraint:
    permitted_values:
      - list_products
`;

const storyboard = (tools) => `
id: temp_buyer_storyboard
fixtures:
  fixture_publisher:
    capabilities:
      supported_protocols: ["media_buy"]
      media_buy:
        lifecycle_tools: ${JSON.stringify(tools)}
`;

function withSourceTree(files, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buyer-fixture-lifecycle-lint-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const file = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const CONTRACT_PATH = 'universal/buyer-fixture-publisher.yaml';
const STORYBOARD_PATH = 'specialisms/temp-buyer/index.yaml';

test('source tree passes the buyer-fixture lifecycle-tools lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real buyer storyboards advertise lifecycle tools the contract does not serve:\n' +
      violations.map((v) => `  ${v.file} — ${v.rule}${v.tool ? ` (${v.tool})` : ''}`).join('\n'),
  );
});

test('the real contract permits only tools it defines a handler for', () => {
  const contract = yaml.load(
    fs.readFileSync(path.join(SOURCE_ROOT, 'universal', 'buyer-fixture-publisher.yaml'), 'utf8'),
  );
  const permitted = contract.authoring_rules.lifecycle_tools_constraint.permitted_values;
  assert.ok(permitted.length > 0, 'permitted_values is non-empty');
  for (const tool of permitted) {
    assert.ok(contract.tool_handlers[tool], `tool_handlers.${tool} is defined`);
  }
});

test('every pending storyboard exists and carries a reason', () => {
  for (const [rel, reason] of Object.entries(PENDING_STORYBOARDS)) {
    assert.ok(fs.existsSync(path.join(SOURCE_ROOT, rel)), `${rel} exists`);
    assert.ok(typeof reason === 'string' && reason.length > 0, `${rel} has a reason`);
  }
});

test('lifecycle_tool_not_permitted: the adcp#7749 drift — buy_products and control_media_buy advertised, no handler', () => {
  withSourceTree(
    {
      [CONTRACT_PATH]: CONTRACT,
      [STORYBOARD_PATH]: storyboard(['list_products', 'buy_products', 'control_media_buy']),
    },
    (dir) => {
      const violations = lint(dir, { pending: {} });
      assert.deepEqual(
        violations.map((v) => [v.rule, v.tool]),
        [
          ['lifecycle_tool_not_permitted', 'buy_products'],
          ['lifecycle_tool_not_permitted', 'control_media_buy'],
        ],
      );
      assert.equal(violations[0].file, STORYBOARD_PATH);
      assert.equal(violations[0].at, 'fixtures.fixture_publisher.capabilities.media_buy.lifecycle_tools');
      assert.match(RULE_MESSAGES.lifecycle_tool_not_permitted(violations[0]), /permitted: list_products/);
    },
  );
});

test('a fixture advertising only permitted tools passes', () => {
  withSourceTree(
    { [CONTRACT_PATH]: CONTRACT, [STORYBOARD_PATH]: storyboard(['list_products']) },
    (dir) => assert.deepEqual(lint(dir, { pending: {} }), []),
  );
});

test('a fixture that advertises no lifecycle_tools passes', () => {
  const doc = `
id: temp_buyer_storyboard
fixtures:
  fixture_publisher:
    capabilities:
      supported_protocols: ["media_buy"]
`;
  withSourceTree({ [CONTRACT_PATH]: CONTRACT, [STORYBOARD_PATH]: doc }, (dir) =>
    assert.deepEqual(lint(dir, { pending: {} }), []),
  );
});

test('storyboards without a fixture publisher are out of scope', () => {
  const doc = `
id: temp_seller_storyboard
fixtures:
  products:
    - product_id: "p1"
      lifecycle_tools: ["buy_products"]
`;
  withSourceTree({ [CONTRACT_PATH]: CONTRACT, [STORYBOARD_PATH]: doc }, (dir) =>
    assert.deepEqual(lint(dir, { pending: {} }), []),
  );
});

test('nested capability blocks (per-persona) are linted too', () => {
  const doc = `
id: temp_orchestrator_storyboard
fixtures:
  fixture_publisher:
    capabilities:
      media_buy:
        lifecycle_tools: ["list_products"]
    seller_personas:
      alpha:
        capabilities:
          media_buy:
            lifecycle_tools: ["list_products", "buy_products"]
`;
  withSourceTree({ [CONTRACT_PATH]: CONTRACT, [STORYBOARD_PATH]: doc }, (dir) => {
    const violations = lint(dir, { pending: {} });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].tool, 'buy_products');
    assert.equal(
      violations[0].at,
      'fixtures.fixture_publisher.seller_personas.alpha.capabilities.media_buy.lifecycle_tools',
    );
  });
});

test('permitted_value_without_handler: the contract cannot permit a tool it does not serve', () => {
  const contract = CONTRACT.replace('      - list_products', '      - list_products\n      - buy_products');
  withSourceTree(
    { [CONTRACT_PATH]: contract, [STORYBOARD_PATH]: storyboard(['list_products', 'buy_products']) },
    (dir) => {
      const violations = lint(dir, { pending: {} });
      assert.deepEqual(
        violations.map((v) => [v.file, v.rule, v.tool]),
        [[CONTRACT_PATH, 'permitted_value_without_handler', 'buy_products']],
      );
    },
  );
});

test('contract_rule_missing: no permitted_values to lint against', () => {
  const contract = `
id: buyer_fixture_publisher
tool_handlers:
  list_products: {}
`;
  withSourceTree(
    { [CONTRACT_PATH]: contract, [STORYBOARD_PATH]: storyboard(['list_products', 'buy_products']) },
    (dir) => {
      const violations = lint(dir, { pending: {} });
      assert.deepEqual(violations.map((v) => v.rule), ['contract_rule_missing']);
    },
  );
});

test('a pending storyboard is exempt while it still drifts', () => {
  withSourceTree(
    {
      [CONTRACT_PATH]: CONTRACT,
      [STORYBOARD_PATH]: storyboard(['list_products', 'request_proposals']),
    },
    (dir) => assert.deepEqual(lint(dir, { pending: { [STORYBOARD_PATH]: 'needs proposal handlers' } }), []),
  );
});

test('stale_pending_entry: a pending storyboard that now passes must leave the list', () => {
  withSourceTree(
    { [CONTRACT_PATH]: CONTRACT, [STORYBOARD_PATH]: storyboard(['list_products']) },
    (dir) => {
      const violations = lint(dir, { pending: { [STORYBOARD_PATH]: 'needs proposal handlers' } });
      assert.deepEqual(
        violations.map((v) => [v.file, v.rule, v.reason]),
        [[STORYBOARD_PATH, 'stale_pending_entry', 'passes']],
      );
    },
  );
});

test('stale_pending_entry: a pending storyboard that no longer exists must leave the list', () => {
  withSourceTree({ [CONTRACT_PATH]: CONTRACT }, (dir) => {
    const violations = lint(dir, { pending: { 'specialisms/gone/index.yaml': 'removed' } });
    assert.deepEqual(
      violations.map((v) => [v.rule, v.reason]),
      [['stale_pending_entry', 'missing']],
    );
  });
});

test('walkLifecycleTools reports the dotted path of each declaration', () => {
  const hits = [
    ...walkLifecycleTools(
      { capabilities: { media_buy: { lifecycle_tools: ['list_products'] } }, products: [{ product_id: 'p1' }] },
      'fixtures.fixture_publisher',
    ),
  ];
  assert.deepEqual(hits, [
    { at: 'fixtures.fixture_publisher.capabilities.media_buy.lifecycle_tools', tools: ['list_products'] },
  ]);
});
