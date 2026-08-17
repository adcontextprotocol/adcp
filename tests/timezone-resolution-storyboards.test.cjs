#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { runStoryboard, runValidations } = require('@adcp/sdk/testing');

const scenariosDir = path.join(
  __dirname,
  '..',
  'static',
  'compliance',
  'source',
  'protocols',
  'media-buy',
  'scenarios'
);

function load(name) {
  return YAML.parse(fs.readFileSync(path.join(scenariosDir, `${name}.yaml`), 'utf8'));
}

function loadMediaBuyIndex() {
  return YAML.parse(fs.readFileSync(path.join(scenariosDir, '..', 'index.yaml'), 'utf8'));
}

function step(doc, id) {
  return doc.phases.flatMap(phase => phase.steps).find(candidate => candidate.id === id);
}

function validation(candidate, check, fieldPath) {
  return candidate.validations.find(item => item.check === check && item.path === fieldPath);
}

test('account timezone scenarios cover all three advertised authority modes', () => {
  const sellerFixed = load('account_timezone_seller_fixed');
  const buyerSelected = load('account_timezone_buyer_selected');
  const sellerAssigned = load('account_timezone_seller_assigned');

  assert.deepEqual(sellerFixed.requires_capability, {
    path: 'account.timezone.mode',
    equals: 'seller_fixed',
  });
  assert.deepEqual(buyerSelected.requires_capability, {
    path: 'account.timezone.account_selection',
    equals: 'buyer_selected',
  });
  assert.deepEqual(sellerAssigned.requires_capability, {
    path: 'account.timezone.account_selection',
    equals: 'seller_assigned',
  });

  assert.equal(step(sellerFixed, 'provision_without_timezone').sample_request.accounts[0].timezone, undefined);
  assert.equal(
    step(buyerSelected, 'provision_selected_timezone').sample_request.accounts[0].timezone,
    '$context.account_timezone'
  );
  assert.equal(step(sellerAssigned, 'provision_without_timezone').sample_request.accounts[0].timezone, undefined);
  assert.equal(
    step(buyerSelected, 'list_by_natural_key').sample_request.account.timezone,
    '$context.account_timezone'
  );

  for (const [doc, stepId] of [
    [sellerFixed, 'provision_without_timezone'],
    [buyerSelected, 'provision_selected_timezone'],
    [sellerAssigned, 'provision_without_timezone'],
  ]) {
    const actionCheck = validation(step(doc, stepId), 'field_value', 'accounts[0].action');
    assert.deepEqual(actionCheck.allowed_values, ['created', 'updated', 'unchanged']);

    const validationContext = {
      taskName: 'sync_accounts',
      agentUrl: 'https://seller.example',
      contributions: new Set(),
    };
    const [failedAction] = runValidations([actionCheck], {
      ...validationContext,
      taskResult: { success: true, data: { accounts: [{ action: 'failed' }] } },
    });
    const [createdAction] = runValidations([actionCheck], {
      ...validationContext,
      taskResult: { success: true, data: { accounts: [{ action: 'created' }] } },
    });
    assert.equal(failedAction.passed, false);
    assert.equal(createdAction.passed, true);
  }
});

test('parent media-buy account setup routes buyer-selected timezone provisioning', () => {
  const doc = loadMediaBuyIndex();
  const defaultSetup = doc.phases.find(phase => phase.id === 'account_setup');
  const buyerSetup = doc.phases.find(phase => phase.id === 'buyer_selected_account_setup');

  assert.deepEqual(defaultSetup.requires_capability, {
    path: 'account.timezone.supported_timezones',
    present: false,
  });
  assert.deepEqual(buyerSetup.requires_capability, {
    path: 'account.timezone.account_selection',
    equals: 'buyer_selected',
  });
  assert.equal(
    step({ phases: [buyerSetup] }, 'sync_accounts_buyer_selected_timezone').sample_request.accounts[0].timezone,
    '$context.account_timezone'
  );
  assert.equal(
    validation(
      step({ phases: [buyerSetup] }, 'sync_accounts_buyer_selected_timezone'),
      'field_value',
      'accounts[0].action'
    ).allowed_values.includes('failed'),
    false
  );

  const downstream = doc.phases.filter(phase => !['account_setup', 'buyer_selected_account_setup'].includes(phase.id));
  assert.doesNotMatch(JSON.stringify(downstream), /"operator":"pinnacle-agency\.example"/);
  assert.match(JSON.stringify(downstream), /"account_id":"\$context\.account_id"/);
});

test('default cap timezone scenarios gate each supported scope and assert durable resolution', () => {
  const cases = [
    ['budget_cap_timezone_account', 'account'],
    ['budget_cap_timezone_fixed', 'fixed'],
  ];

  for (const [name, basis] of cases) {
    const doc = load(name);
    assert.deepEqual(doc.requires_capability, {
      path: 'media_buy.budget_capping.timezone_basis',
      equals: basis,
    });
    assert.deepEqual(doc.phases.find(phase => phase.id === 'aggregate_cap').requires_capability, {
      path: 'media_buy.budget_capping.supported_scopes',
      contains: 'media_buy',
    });
    assert.deepEqual(doc.phases.find(phase => phase.id === 'package_cap').requires_capability, {
      path: 'media_buy.budget_capping.supported_scopes',
      contains: 'package',
    });
    assert.ok(validation(step(doc, 'create_aggregate_cap_buy'), basis === 'account' ? 'field_value' : 'field_equals_context', 'budget_cap_timezone'));
    assert.ok(validation(step(doc, 'read_package_cap_buy'), basis === 'account' ? 'field_value' : 'field_equals_context', 'media_buys[0].budget_cap_timezone'));

    const reporting = validation(step(doc, 'read_reporting_clock'), 'field_value', 'products[0].reporting_capabilities.timezone');
    assert.equal(reporting.value, 'Europe/London');
    assert.equal(step(doc, 'read_reporting_clock').task, 'list_products');
    assert.deepEqual(step(doc, 'read_reporting_clock').sample_request.criteria.product_ids, [
      basis === 'account' ? 'timezone_account_display' : 'timezone_fixed_display',
    ]);
    assert.ok(validation(step(doc, 'read_financial_timezone'), 'field_present', 'timezone'));
  }
});

test('buyer override scenario covers aggregate and package caps with one shared boundary', () => {
  const doc = load('budget_cap_timezone_override');
  assert.deepEqual(doc.requires_capability, {
    path: 'media_buy.budget_capping.buyer_timezone_override',
    equals: true,
  });

  for (const phaseId of ['aggregate_override', 'package_override']) {
    const phase = doc.phases.find(candidate => candidate.id === phaseId);
    assert.equal(phase.requires_capability.path, 'media_buy.budget_capping.supported_scopes');
  }

  const aggregate = step(doc, 'create_aggregate_override_buy');
  const packageOnly = step(doc, 'create_package_override_buy');
  assert.equal(aggregate.sample_request.budget_cap_timezone, 'Pacific/Honolulu');
  assert.equal(packageOnly.sample_request.budget_cap_timezone, 'Pacific/Honolulu');
  assert.equal(packageOnly.sample_request.packages[0].daily_budget_cap, 80);
  assert.equal(
    validation(step(doc, 'read_aggregate_override_buy'), 'field_value', 'media_buys[0].budget_cap_timezone').value,
    'Pacific/Honolulu'
  );
  assert.equal(
    validation(step(doc, 'read_package_override_buy'), 'field_value', 'media_buys[0].budget_cap_timezone').value,
    'Pacific/Honolulu'
  );
});

test('unadvertised buyer override is an executable negative conformance path', async () => {
  const doc = load('budget_cap_timezone_override_rejected');
  assert.deepEqual(doc.requires_capability, {
    path: 'media_buy.budget_capping.supported_scopes',
    contains: 'media_buy',
  });
  assert.deepEqual(doc.phases.map(phase => phase.requires_capability), [
    { path: 'media_buy.budget_capping.buyer_timezone_override', equals: false },
    { path: 'media_buy.budget_capping.buyer_timezone_override', present: false },
  ]);

  const negativePhase = doc.phases.find(phase => phase.id === 'not_advertised');
  const executablePhase = {
    ...negativePhase,
    steps: negativePhase.steps.map(candidate => ({
      ...candidate,
      validations: candidate.validations.filter(item => item.check === 'error_code'),
    })),
  };
  const tools = ['get_adcp_capabilities', 'create_media_buy', 'comply_test_controller'];
  const baseOptions = {
    _profile: {
      tools,
      raw_capabilities: {
        media_buy: {
          budget_capping: {
            supported_scopes: ['media_buy'],
            supported_periods: ['daily'],
            timezone_basis: 'account',
          },
        },
      },
    },
    agentTools: tools,
    skip_controller_seeding: true,
  };
  const storyboard = {
    ...doc,
    prerequisites: undefined,
    fixtures: undefined,
    phases: [executablePhase],
  };

  const rejected = await runStoryboard('https://agent.example/mcp', storyboard, {
    ...baseOptions,
    _client: {
      resetContext() {},
      async createMediaBuy() {
        return {
          success: false,
          data: {
            errors: [{ code: 'UNSUPPORTED_FEATURE', message: 'Buyer timezone override is not supported' }],
          },
        };
      },
    },
  });
  assert.equal(rejected.overall_passed, true);
  assert.equal(rejected.passed_count, 1);

  const incorrectlyAccepted = await runStoryboard('https://agent.example/mcp', storyboard, {
    ...baseOptions,
    _client: {
      resetContext() {},
      async createMediaBuy() {
        return { success: true, data: { media_buy_id: 'incorrectly_accepted' } };
      },
    },
  });
  assert.equal(incorrectlyAccepted.overall_passed, false);
  assert.equal(incorrectlyAccepted.failed_count, 1);
});
