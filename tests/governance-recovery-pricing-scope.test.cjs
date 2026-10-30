'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { runStoryboard } = require('@adcp-protocol/fixture-test-sdk/testing');
const root = path.join(__dirname, '..');
const scenarioPath = path.join(root, 'static/compliance/source/protocols/media-buy/scenarios/governance_denied_recovery.yaml');
const load = () => YAML.parse(fs.readFileSync(scenarioPath, 'utf8'));

async function probe(mode) {
  const storyboard = load();
  // One in-process endpoint stands in for both routed agents. Preserve the
  // authored pricing checks, phase guards, account setup and schema validation.
  delete storyboard.requires;
  delete storyboard.default_agent;
  for (const phase of storyboard.phases) for (const step of phase.steps) {
    delete step.agent;
    if (step.task === 'sync_accounts') step.validations = step.validations.filter(v => v.check !== 'response_schema');
  }
  const fixture = YAML.parse(fs.readFileSync(path.join(root,
    'static/compliance/source/protocols/media-buy/scenarios/canonical_formats.yaml'), 'utf8'))
    .phases[0].steps[0].sample_request.params.fixture;
  const products = [{ product_id: 'native-fixed', ...structuredClone(fixture),
    pricing_options: [{ pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }] }];
  const calls = [];
  const client = {
    resetContext() {},
    async syncAccounts(request) {
      calls.push({ task: 'sync_accounts', request });
      return { success: true, data: { accounts: [{ account_id: 'scope-account' }], context: request.context } };
    },
    async getProducts(request) {
      calls.push({ task: 'get_products', request });
      assert.equal(request.filters.is_fixed_price, true, 'governed payloads retain their fixed-rate slice');
      if (mode === 'transport') throw new Error('Deliberate discovery transport failure');
      if (mode === 'rejected') return { success: false, error: 'Deliberate seller rejection' };
      return { success: true, data: { status: 'completed', cache_scope: 'account',
        products: mode === 'fixed' ? products : mode === 'malformed' ? 'invalid-products-array' : [],
        context: request.context } };
    },
    async executeTask(task, request) {
      if (task === 'get_products') return this.getProducts(request);
      if (task === 'sync_accounts') return this.syncAccounts(request);
      calls.push({ task, request });
      throw new Error('Reached governance work after pricing applicability');
    },
  };
  const tools = [...new Set(storyboard.phases.flatMap(p => p.steps.map(s => s.task)))];
  const result = await runStoryboard('https://seller.example/mcp', storyboard, {
    _client: client, agentTools: tools,
    _profile: { tools, raw_capabilities: { media_buy: { governance_aware: true },
      adcp: { governance_enforcement: { tasks: [{ task: 'create_media_buy', modes: ['signed_context', 'online_execution_check'] }] } } } },
  });
  return { result, calls };
}

test('empty fixed-price discovery skips recovery before any governance writes', async () => {
  const { result, calls } = await probe('empty');
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.ok(result.skipped_count > 0, 'unavailable fixed-rate recovery coverage is explicit');
  assert.deepEqual(calls.map(c => c.task), ['sync_accounts', 'get_products']);
  const scope = result.phases.find(p => p.phase_id === 'fixed_rate_applicability');
  assert.equal(scope.passed, true);
  assert.deepEqual(result.context.governance_fixed_rate_products, []);
  assert.ok(result.phases.filter(p => p !== scope).every(p => p.steps.every(s => s.skipped)));
});

for (const mode of ['malformed', 'transport', 'rejected']) {
  test(`${mode} applicability discovery remains a failure`, async () => {
    const { result, calls } = await probe(mode);
    assert.equal(result.overall_passed, false);
    assert.ok(result.failed_count > 0);
    assert.deepEqual(calls.map(c => c.task), ['sync_accounts', 'get_products']);
  });
}

test('a valid fixed-rate witness opens the governance phases', async () => {
  const { result, calls } = await probe('fixed');
  assert.equal(result.phases.find(p => p.phase_id === 'fixed_rate_applicability').passed, true,
    JSON.stringify(result.phases[0]));
  assert.ok(calls.some(c => c.task === 'sync_plans'), 'the applicable workflow attempts its real governance work');
  assert.equal(result.overall_passed, false, 'the deliberate governance sentinel failure remains visible');
});

test('every later phase depends on pricing applicability and matrix counts include the extra read', () => {
  const storyboard = load();
  assert.equal(storyboard.phases[0].id, 'fixed_rate_applicability');
  assert.deepEqual(storyboard.phases[0].steps.map(s => s.task), ['sync_accounts', 'get_products']);
  const unavailable = storyboard.phases.find(p => p.id === 'fixed_rate_recovery_unavailable');
  assert.equal(unavailable.skip_if, 'context.governance_fixed_rate_products.0');
  assert.ok(unavailable.steps.every(s => s.task === undefined), 'the coverage marker dispatches no tool');
  assert.ok(storyboard.phases.slice(1).filter(p => p !== unavailable)
    .every(p => p.skip_if === '!context.governance_fixed_rate_products.0'));
  const count = storyboard.phases.filter(p => p !== unavailable).flatMap(p => p.steps).length;
  for (const file of ['scripts/run-storyboards-matrix.sh', '.github/workflows/training-agent-storyboards.yml']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (text.includes('media_buy_seller/governance_denied_recovery:')) {
      assert.ok(text.includes(`media_buy_seller/governance_denied_recovery:${count}:0`), file);
    }
  }
});
