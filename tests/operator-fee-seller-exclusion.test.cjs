'use strict';

// Sellers MUST NOT author operator_fee in a price breakdown or in
// eligible_adjustments (enums/adjustment-kind.json, adcp#8367). The schema
// cannot enforce it because buying platforms share price-breakdown.json, so
// seller storyboards carry advisory field_excludes checks instead.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { runValidations } = require('@adcp/sdk/testing');

const SCENARIOS = path.join(__dirname, '..', 'static', 'compliance', 'source', 'protocols', 'media-buy', 'scenarios');
const EXPIRY = '17.0.0';

const TARGETS = [
  {
    file: 'product_filter_behavior.yaml',
    step: 'get_filtered_brief_products',
    task: 'get_products',
    paths: [
      'products[*].pricing_options[*].eligible_adjustments[*]',
      'products[*].pricing_options[*].price_breakdown.adjustments[*].kind',
    ],
  },
  {
    file: 'total_budget_redistribution.yaml',
    step: 'create_fixed_buy',
    task: 'create_media_buy',
    paths: ['packages[*].price_breakdown.adjustments[*].kind'],
  },
  {
    file: 'total_budget_redistribution.yaml',
    step: 'update_total_budget',
    task: 'update_media_buy',
    paths: ['affected_packages[*].price_breakdown.adjustments[*].kind'],
  },
];

const breakdown = kinds => ({
  list_price: 10,
  adjustments: kinds.map(kind => ({ kind, name: `${kind}_example`, rate: 0.1 })),
});

const RESPONSES = {
  get_products: kinds => ({
    products: [{
      product_id: 'p1',
      pricing_options: [
        { pricing_option_id: 'clean', eligible_adjustments: ['fee', 'discount'] },
        { pricing_option_id: 'graded', eligible_adjustments: kinds, price_breakdown: breakdown(kinds) },
      ],
    }],
  }),
  create_media_buy: kinds => ({
    media_buy_id: 'mb1',
    packages: [{ package_id: 'pk1' }, { package_id: 'pk2', price_breakdown: breakdown(kinds) }],
  }),
  update_media_buy: kinds => ({
    media_buy_id: 'mb1',
    affected_packages: [{ package_id: 'pk1', price_breakdown: breakdown(kinds) }],
  }),
};

function authoredStep(target) {
  const doc = YAML.parse(fs.readFileSync(path.join(SCENARIOS, target.file), 'utf8'));
  const step = doc.phases.flatMap(phase => phase.steps).find(candidate => candidate.id === target.step);
  assert.ok(step, `${target.file} has step ${target.step}`);
  return { doc, step };
}

function operatorFeeChecks(step) {
  return step.validations.filter(check => check.check === 'field_excludes' && check.value === 'operator_fee');
}

function grade(target, step, data) {
  return runValidations(operatorFeeChecks(step), {
    taskName: target.task,
    agentUrl: 'https://seller.example/mcp',
    contributions: new Set(),
    taskResult: { success: true, data },
  });
}

for (const target of TARGETS) {
  test(`${target.file} ${target.step} excludes seller-authored operator_fee`, () => {
    const { doc, step } = authoredStep(target);
    assert.equal(step.task, target.task);
    assert.ok(doc.requires.includes('field_excludes_runner'), 'field_excludes requires field_excludes_runner');
    const checks = operatorFeeChecks(step);
    assert.deepEqual(checks.map(check => check.path), target.paths);
    for (const check of checks) {
      assert.equal(check.severity, 'advisory');
      assert.equal(check.expires_after_version, EXPIRY);
    }
  });

  test(`${target.file} ${target.step} grades operator_fee as an advisory failure`, () => {
    const { step } = authoredStep(target);
    const leaked = grade(target, step, RESPONSES[target.task](['fee', 'operator_fee']));
    assert.equal(leaked.length, target.paths.length);
    for (const result of leaked) {
      assert.equal(result.passed, false, result.path);
      assert.equal(result.not_applicable, undefined, 'the runner grades field_excludes natively');
      // Advisory until the runner reaches EXPIRY, then promoted to required.
      assert.equal(result.severity, result.severity_promoted_from_advisory ? 'required' : 'advisory');
    }
    const clean = grade(target, step, RESPONSES[target.task](['fee', 'discount']));
    assert.ok(clean.every(result => result.passed), 'other adjustment kinds pass');
    const undisclosed = grade(target, step, { products: [], packages: [], affected_packages: [] });
    assert.ok(undisclosed.every(result => result.passed), 'no breakdown passes trivially');
  });
}
