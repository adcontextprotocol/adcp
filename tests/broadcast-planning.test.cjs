/**
 * Contract test for experimental broadcast planning goals and plan breakdown
 * (media_buy.planning_goals, media_buy.plan_breakdown).
 *
 * A buyer sends criteria.planning_goals on request_proposals or a revise
 * refinement; every proposal version answers with plan_breakdown (totals and
 * allocations by market, station, programming format, daypart, week and spot
 * length) and goal_results (met, missed or not_supported per goal). The
 * Hearthside Coffee fixtures are the plan iHeartMedia's Harmony planner showed
 * on 20 Nov: the figures are read off its screens, and the few that are
 * derived are named in docs/media-buy/product-discovery/broadcast-planning.mdx.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'broadcast-planning');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

const compiled = new Map();
function compile(schemaId) {
  if (!compiled.has(schemaId)) {
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async (uri) => readBuiltSchema(uri) });
    addFormats(ajv);
    compiled.set(schemaId, ajv.compileAsync(readBuiltSchema(schemaId)));
  }
  return compiled.get(schemaId);
}
const errors = (validate) => JSON.stringify(validate.errors, null, 2);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const within = (actual, expected, tolerance, where) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${where}: ${actual} is not within ${tolerance} of ${expected}`);

const REQUEST = fixture('hearthside-request.json');
const PLAN = fixture('hearthside-plan-breakdown.json');
const RESULTS = fixture('hearthside-goal-results.json');
const byDimension = (plan, dimension) => plan.breakdowns.find((breakdown) => breakdown.dimension === dimension);

const DRAFT = {
  proposal_id: 'hearthside_draft_01',
  proposal_kind: 'new_media_buy',
  proposal_status: 'draft',
  expires_at: '2026-12-01T17:00:00Z',
  name: 'Hearthside winter, New England radio',
  commercial_terms: {
    brand: { domain: 'hearthsidecoffee.example' },
    purchases: [
      {
        product_id: 'iheart_new_england_a2554',
        pricing_option_id: 'cpm_usd',
        pricing: { pricing_option_id: 'cpm_usd', pricing_model: 'cpm', currency: 'USD', fixed_price: 28.39 },
        budget: 198476,
        start_time: '2026-11-16T00:00:00Z',
        end_time: '2026-12-20T23:59:59Z',
      },
    ],
    start_time: '2026-11-16T00:00:00Z',
    end_time: '2026-12-20T23:59:59Z',
    total_budget: { amount: 198476, currency: 'USD' },
  },
  terms_digest: 'sha256:IO3B2jLn52O7-u_xeztyhTFDUJWbV4mQrCcTfCWpAQg',
};

test('request: the Hearthside brief with planning goals is a valid request_proposals', async () => {
  const validate = await compile('/schemas/media-buy/request-proposals-request.json');
  assert.equal(validate(REQUEST.request_proposals), true, errors(validate));
});

test('request: every planning goal in one criteria object validates', async () => {
  const validate = await compile('/schemas/media-buy/product-discovery-criteria.json');
  const full = {
    planning_goals: {
      ...REQUEST.full_goals,
      objective: 'max_efficiency',
      delivery_target: { metric: 'grps', value: 100, max_cost: { amount: 1200, currency: 'USD' } },
      must_exclude: { stations: [{ type: 'station_id', value: 'WRKO-AM' }], programming_formats: ['NEWSTALK'] },
      audience_basis: { measurement_source: 'transunion', demographic_system: 'custom', demographic: 'Adults 25-54', universe: 2500000 },
    },
  };
  assert.equal(validate(full), true, errors(validate));
  assert.equal(validate({ planning_goals: { objective: 'max_reach' } }), true, errors(validate));
});

test('request: malformed planning goals are rejected', async () => {
  const validate = await compile('/schemas/media-buy/product-discovery-criteria.json');
  const bad = (goals) => validate({ planning_goals: goals });
  assert.equal(bad({}), true, 'an empty object clears goals');
  assert.equal(bad({ budget_mode: 'auto' }), false, 'budget_mode is set or suggest');
  assert.equal(bad({ objective: 'max_frequency' }), false, 'objective is max_reach or max_efficiency');
  assert.equal(bad({ delivery_target: { value: 100 } }), false, 'delivery_target needs a metric');
  assert.equal(bad({ delivery_target: { metric: 'grps' } }), false, 'delivery_target needs a value');
  assert.equal(bad({ delivery_target: { metric: 'clicks', value: 10 } }), false, 'delivery_target metric is grps or impressions');
  assert.equal(bad({ delivery_target: { metric: 'grps', value: 100, max_cost: { amount: 1200 } } }), false, 'max_cost needs a currency');
  assert.equal(bad({ max_frequency: { value: 3 } }), false, 'max_frequency needs a window');
  assert.equal(bad({ max_frequency: { value: 3, window: { interval: 4, unit: 'weeks' } } }), false, 'weeks is not a duration unit');
  assert.equal(bad({ delivery_rules: { spot_length_mix: [{ duration_seconds: 30 }] } }), false, 'a mix entry needs a share');
  assert.equal(bad({ delivery_rules: { max_spots_per_hour: 0 } }), false, 'at least one spot per hour');
  assert.equal(bad({ delivery_rules: { pacing: 'level' } }), false, 'pacing is the pacing enum');
  assert.equal(bad({ must_include: {} }), false, 'a selector names at least one thing');
});

test('refinement: criteria.planning_goals is a valid revise and is rejected on finalize', async () => {
  const validate = await compile('/schemas/media-buy/proposal-refinement.json');
  const revise = {
    proposal_id: 'hearthside_draft_01',
    action: 'revise',
    criteria: {
      planning_goals: { ...REQUEST.request_proposals.criteria.planning_goals, max_frequency: { value: 3, window: { interval: 1, unit: 'campaign' } } },
    },
    ask: 'Hold average frequency to 3 over the whole flight.',
  };
  assert.equal(validate(revise), true, errors(validate));
  assert.equal(validate({ proposal_id: 'hearthside_draft_01', action: 'finalize', criteria: revise.criteria }), false);
});

test('plan breakdown: the Hearthside plan validates, on its own and inside a canonical proposal', async () => {
  const validatePlan = await compile('/schemas/core/plan-breakdown.json');
  assert.equal(validatePlan(PLAN), true, errors(validatePlan));
  const validateProposal = await compile('/schemas/core/canonical-proposal.json');
  const proposal = { ...DRAFT, plan_breakdown: PLAN, goal_results: RESULTS };
  assert.equal(validateProposal(proposal), true, errors(validateProposal));
  assert.equal(validateProposal(DRAFT), true, 'a proposal without the new fields is unchanged');
});

test('plan breakdown: complete breakdowns partition the plan totals', () => {
  const { totals } = PLAN;
  for (const dimension of ['market', 'week', 'spot_length']) {
    const rows = byDimension(PLAN, dimension).allocations;
    assert.equal(sum(rows, 'budget'), totals.budget, `${dimension}: budget sums to the plan budget`);
  }
  const markets = byDimension(PLAN, 'market').allocations;
  within(sum(markets, 'impressions'), totals.impressions, 1, 'market impressions sum to the plan impressions');
  assert.equal(markets.length, totals.market_count, 'one allocation per market');
  // A truncated breakdown is a lower bound, and says how many slices exist.
  for (const dimension of ['station', 'programming_format', 'daypart']) {
    const breakdown = byDimension(PLAN, dimension);
    assert.equal(breakdown.truncated, true, `${dimension} lists only some slices`);
    assert.ok(breakdown.total_count > breakdown.allocations.length, `${dimension}: total_count exceeds the rows shown`);
    assert.ok(sum(breakdown.allocations, 'budget') < totals.budget, `${dimension}: shown rows are below the plan budget`);
  }
  assert.equal(byDimension(PLAN, 'station').total_count, totals.station_count);
});

test('plan breakdown: CPM, CPP and the keys that tie rows together are consistent', () => {
  const { totals } = PLAN;
  within(totals.cpm, (totals.budget / totals.impressions) * 1000, 0.005, 'plan CPM is budget / impressions * 1000');
  within(totals.cpp, totals.budget / totals.grps, 1, 'plan CPP is budget / grps');
  for (const breakdown of PLAN.breakdowns) {
    const keys = breakdown.allocations.map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length, `${breakdown.dimension}: keys are unique`);
    for (const row of breakdown.allocations)
      if (row.cpm !== undefined && row.impressions) within(row.cpm, (row.budget / row.impressions) * 1000, 0.01, `${row.key} CPM`);
  }
  const marketKeys = new Set(byDimension(PLAN, 'market').allocations.map((row) => row.key));
  for (const row of byDimension(PLAN, 'station').allocations) assert.ok(marketKeys.has(row.within.key), `${row.key} sits in a listed market`);
  const windows = totals.reach_frequency.map((point) => JSON.stringify(point.window));
  assert.equal(new Set(windows).size, windows.length, 'reach_frequency windows are unique');
});

test('goal results: one per requested goal, consistent with the plan', () => {
  const requested = REQUEST.request_proposals.criteria.planning_goals;
  const goalKeys = ['objective', 'delivery_target', 'max_frequency', 'must_include', 'must_exclude'];
  const expected = [...goalKeys.filter((key) => requested[key] !== undefined), ...Object.keys(requested.delivery_rules ?? {})];
  assert.deepEqual(RESULTS.map((result) => result.goal).sort(), expected.sort(), 'each requested goal is answered once');

  const frequency = RESULTS.find((result) => result.goal === 'max_frequency');
  const fourWeeks = PLAN.totals.reach_frequency.find((point) => point.window.interval === 28);
  assert.equal(frequency.target, requested.max_frequency.value);
  assert.equal(frequency.achieved, fourWeeks.frequency);
  assert.equal(frequency.status, frequency.achieved <= frequency.target ? 'met' : 'missed');

  const include = RESULTS.find((result) => result.goal === 'must_include');
  assert.equal(include.status, 'missed');
  assert.deepEqual(include.unmet_items, ['Portland, ME', 'Burlington, VT']);
});

test('goal results: the same plan reads missed when the frequency window is the whole flight', () => {
  const campaign = PLAN.totals.reach_frequency.find((point) => point.window.unit === 'campaign');
  assert.ok(campaign.frequency > 3, 'campaign frequency exceeds the ceiling of 3');
});

test('plan breakdown and goal results: malformed shapes are rejected', async () => {
  const validatePlan = await compile('/schemas/core/plan-breakdown.json');
  const validateResult = await compile('/schemas/core/goal-result.json');
  const mutate = (change) => {
    const plan = clone(PLAN);
    change(plan);
    return plan;
  };
  assert.equal(validatePlan(mutate((plan) => delete plan.currency)), false, 'currency is required');
  assert.equal(validatePlan(mutate((plan) => delete plan.totals)), false, 'totals are required');
  assert.equal(validatePlan(mutate((plan) => (plan.breakdowns[0].dimension = 'region'))), false, 'unknown dimension');
  assert.equal(validatePlan(mutate((plan) => (plan.breakdowns[0].dimension = 'custom'))), false, 'custom needs custom_dimension');
  assert.equal(validatePlan(mutate((plan) => delete plan.breakdowns[0].allocations[0].key)), false, 'an allocation needs a key');
  assert.equal(validatePlan(mutate((plan) => delete plan.breakdowns[0].allocations[0].budget)), false, 'an allocation needs a budget');
  assert.equal(validatePlan(mutate((plan) => (plan.breakdowns[0].allocations[0].composition_rate = 39.8))), false, 'composition_rate is 0 to 1');
  assert.equal(validatePlan(mutate((plan) => (plan.totals.reach_frequency[0] = { window: { interval: 28, unit: 'days' } }))), false, 'a point needs reach or frequency');
  assert.equal(validatePlan(mutate((plan) => (plan.totals.reach_frequency[0].window = { interval: 4, unit: 'weeks' }))), false, 'weeks is not a duration unit');
  assert.equal(validateResult({ goal: 'max_frequency', status: 'partly' }), false, 'status is met, missed or not_supported');
  assert.equal(validateResult({ goal: 'budget_mode', status: 'met' }), false, 'budget_mode is an input, not a goal');
  assert.equal(validateResult({ goal: 'daypart_mix', status: 'not_supported' }), true, errors(validateResult));
  assert.equal(validateResult({ goal: 'must_include', status: 'missed', unmet_items: [] }), false, 'unmet_items is non-empty when present');
});

test('capabilities: media_buy declares the planning goals and breakdown dimensions it supports', async () => {
  const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  const caps = (mediaBuy) => ({ adcp: { major_versions: [3] }, supported_protocols: ['media_buy'], media_buy: mediaBuy });
  // Only errors under /media_buy are ours: a minimal document omits unrelated required members.
  const mediaBuyErrors = (doc) => (validate(doc) ? [] : validate.errors).filter((error) => error.instancePath.startsWith('/media_buy'));
  const ok = caps({
    planning_goals: { supported_goals: ['max_frequency', 'must_include', 'delivery_target', 'max_cost'], supported_objectives: ['max_reach'] },
    plan_breakdown: { dimensions: ['market', 'station', 'programming_format', 'daypart', 'week', 'spot_length'] },
  });
  assert.deepEqual(mediaBuyErrors(ok), []);
  assert.ok(mediaBuyErrors(caps({ planning_goals: { supported_goals: ['budget_mode'] } })).length > 0, 'budget_mode has no goal key');
  assert.ok(mediaBuyErrors(caps({ plan_breakdown: { dimensions: ['region'] } })).length > 0, 'unknown dimension');
});
