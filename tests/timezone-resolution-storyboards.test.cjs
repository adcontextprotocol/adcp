#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { loadStoryboardFile, runStoryboard, runValidations } = require('@adcp/sdk/testing');

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

function loadExecutable(name) {
  const doc = loadStoryboardFile(path.join(scenariosDir, `${name}.yaml`));
  return {
    ...doc,
    prerequisites: undefined,
    fixtures: undefined,
  };
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

function accountRefsIn(phases) {
  const refs = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && value.account && typeof value.account === 'object') {
      refs.push(value.account);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(phases);
  return refs;
}

function accountResult(account, timezone, action) {
  return {
    account_id: `account-${timezone.replaceAll('/', '-')}`,
    name: `Timezone test account (${timezone})`,
    brand: account.brand,
    operator: account.operator,
    ...(account.operator_unit && { operator_unit: account.operator_unit }),
    timezone,
    billing: account.billing ?? 'operator',
    sandbox: account.sandbox ?? true,
    status: 'active',
    ...(action && { action }),
  };
}

function capabilityResult(accountTimezone) {
  return {
    status: 'completed',
    adcp: {
      major_versions: [3],
      supported_versions: ['3.1'],
      idempotency: { supported: false },
    },
    supported_protocols: ['media_buy'],
    account: {
      supported_billing: ['operator'],
      timezone: accountTimezone,
    },
  };
}

function timezoneProfile(accountTimezone) {
  const tools = ['get_adcp_capabilities', 'sync_accounts', 'list_accounts'];
  return {
    tools,
    options: {
      _profile: {
        tools,
        raw_capabilities: { account: { timezone: accountTimezone } },
      },
      agentTools: tools,
      skip_controller_seeding: true,
    },
  };
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
  for (const scenario of [sellerFixed, sellerAssigned]) {
    assert.equal(step(scenario, 'provision_without_timezone').sample_request.accounts[0].sandbox, true);
  }
  assert.equal(step(sellerFixed, 'list_seller_fixed_account').sample_request.account.sandbox, true);
  assert.equal(step(sellerAssigned, 'list_seller_assigned_account').sample_request.account.sandbox, true);
  assert.equal(
    step(buyerSelected, 'list_by_natural_key').sample_request.account.timezone,
    '$context.account_timezone'
  );

  for (const [doc, stepId, allowedActions] of [
    [sellerFixed, 'provision_without_timezone', ['created', 'updated', 'unchanged']],
    [buyerSelected, 'provision_selected_timezone', ['created']],
    [sellerAssigned, 'provision_without_timezone', ['created', 'updated', 'unchanged']],
  ]) {
    const actionCheck = validation(step(doc, stepId), 'field_value', 'accounts[0].action');
    assert.deepEqual(actionCheck.allowed_values ?? [actionCheck.value], allowedActions);

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

test('parent flow carries the correct complete natural AccountRef through each timezone branch', () => {
  const doc = loadMediaBuyIndex();
  const defaultSetup = doc.phases.find(phase => phase.id === 'account_setup');
  const buyerSetup = doc.phases.find(phase => phase.id === 'buyer_selected_account_setup');
  const defaultSync = step({ phases: [defaultSetup] }, 'sync_accounts');
  const buyerSync = step({ phases: [buyerSetup] }, 'sync_accounts_buyer_selected_timezone');

  assert.deepEqual(defaultSetup.requires_capability, {
    path: 'account.timezone.supported_timezones',
    present: false,
  });
  assert.deepEqual(buyerSetup.requires_capability, {
    path: 'account.timezone.account_selection',
    equals: 'buyer_selected',
  });
  assert.equal(defaultSync.context_outputs, undefined);
  assert.equal(validation(defaultSync, 'field_present', 'accounts[0].account_id'), undefined);
  assert.equal(defaultSync.sample_request.accounts[0].sandbox, true);
  assert.equal(buyerSync.context_outputs, undefined);
  assert.equal(validation(buyerSync, 'field_present', 'accounts[0].account_id'), undefined);
  assert.equal(buyerSync.sample_request.accounts[0].timezone, '$context.account_timezone');
  assert.equal(buyerSync.sample_request.accounts[0].sandbox, true);

  const defaultLifecycle = doc.phases.filter(phase =>
    ['governance_setup', 'product_discovery', 'create_buy', 'delivery_monitoring'].includes(phase.id)
  );
  const buyerLifecycle = doc.phases.filter(phase => phase.id.startsWith('buyer_selected_') && phase.id !== 'buyer_selected_account_setup');
  const defaultAccount = {
    brand: { domain: 'acmeoutdoor.example' },
    operator: 'pinnacle-agency.example',
    sandbox: true,
  };
  const buyerAccount = { ...defaultAccount, timezone: '$context.account_timezone' };

  assert.deepEqual(accountRefsIn(defaultLifecycle), Array(5).fill(defaultAccount));
  assert.deepEqual(accountRefsIn(buyerLifecycle), Array(5).fill(buyerAccount));
  assert.doesNotMatch(JSON.stringify(doc), /\$context\.account_id/);
  assert.equal(doc.phases.flatMap(phase => phase.steps).some(candidate => candidate.task === 'list_accounts'), false);
});

test('buyer-selected storyboard covers cold-start reconnect and an immutable timezone switch', () => {
  const doc = load('account_timezone_buyer_selected');
  const discovery = step(doc, 'discover_supported_timezones');
  const provision = step(doc, 'provision_selected_timezone');
  const reconnect = step(doc, 'reconnect_existing_timezone');
  const second = step(doc, 'provision_second_timezone');
  const switchPhase = doc.phases.find(phase => phase.id === 'select_second_timezone');

  assert.deepEqual(
    discovery.context_outputs.find(output => output.name === 'timezone_test_operator_unit_id'),
    { name: 'timezone_test_operator_unit_id', generate: 'uuid_v4' }
  );
  assert.equal(provision.sample_request.accounts[0].sandbox, true);
  assert.equal(
    validation(provision, 'field_value', 'accounts[0].action').value,
    'created'
  );
  assert.deepEqual(reconnect.sample_request.accounts[0], {
    brand: { domain: '$context.recovered_brand_domain' },
    operator: '$context.recovered_operator',
    operator_unit: {
      id: '$context.recovered_operator_unit_id',
      name: 'Timezone reconciliation test',
    },
    timezone: '$context.recovered_account_timezone',
    billing: 'operator',
    sandbox: '$context.recovered_sandbox',
  });
  assert.equal(
    validation(reconnect, 'field_value', 'accounts[0].action').value,
    'unchanged'
  );
  assert.deepEqual(switchPhase.requires_capability, {
    path: 'account.timezone.supported_timezones.1',
    present: true,
  });
  assert.deepEqual(doc.phases.find(phase => phase.id === 'verify_both_timezone_keys').requires_capability, {
    path: 'account.timezone.supported_timezones.1',
    present: true,
  });
  assert.equal(second.sample_request.accounts[0].timezone, '$context.second_account_timezone');
  assert.equal(
    validation(second, 'field_value', 'accounts[0].action').value,
    'created'
  );
  assert.equal(
    step(doc, 'read_original_after_second_timezone').sample_request.account.timezone,
    '$context.account_timezone'
  );
  assert.equal(
    step(doc, 'read_second_timezone_key').sample_request.account.timezone,
    '$context.second_account_timezone'
  );
  assert.doesNotMatch(JSON.stringify(doc), /\$context\.account_id/);
});

test('seller-fixed UTC ignores West/East buyer preferences on both write and read', async () => {
  const storyboard = loadExecutable('account_timezone_seller_fixed');
  const accountTimezone = { mode: 'seller_fixed', fixed_timezone: 'UTC' };
  const { options } = timezoneProfile(accountTimezone);
  async function execute({ buyerPreference, syncTimezone = 'UTC', listTimezone = 'UTC' }) {
    const syncRequests = [];
    const listRequests = [];
    const result = await runStoryboard('https://agent.example/mcp', storyboard, {
      ...options,
      context: { buyer_local_timezone: buyerPreference },
      _client: {
        resetContext() {},
        async getAdcpCapabilities() {
          return { success: true, data: capabilityResult(accountTimezone) };
        },
        async syncAccounts(request) {
          syncRequests.push(request);
          return {
            success: true,
            data: {
              status: 'completed',
              accounts: [accountResult(request.accounts[0], syncTimezone, 'created')],
            },
          };
        },
        async listAccounts(request) {
          listRequests.push(request);
          return {
            success: true,
            data: { status: 'completed', accounts: [accountResult(request.account, listTimezone)] },
          };
        },
      },
    });
    return { result, syncRequests, listRequests };
  }

  for (const buyerPreference of ['America/Los_Angeles', 'America/New_York']) {
    const valid = await execute({ buyerPreference });
    assert.equal(valid.result.overall_passed, true, JSON.stringify(valid.result, null, 2));
    assert.equal(valid.syncRequests.length, 1);
    assert.equal(valid.syncRequests[0].accounts[0].timezone, undefined);
    assert.doesNotMatch(JSON.stringify(valid.syncRequests[0]), new RegExp(buyerPreference));
    assert.deepEqual(valid.listRequests[0].account, {
      brand: { domain: 'acmeoutdoor.example' },
      operator: 'pinnacle-agency.example',
      sandbox: true,
    });
  }

  const wrongSyncClock = await execute({
    buyerPreference: 'America/Los_Angeles',
    syncTimezone: 'America/New_York',
  });
  assert.equal(wrongSyncClock.result.overall_passed, false);

  const wrongReadClock = await execute({
    buyerPreference: 'America/New_York',
    listTimezone: 'America/New_York',
  });
  assert.equal(wrongReadClock.result.overall_passed, false);
});

test('buyer-selected UTC-only seller reconciles a local preference and reconnects exactly', async () => {
  const storyboard = loadExecutable('account_timezone_buyer_selected');
  const accountTimezone = {
    mode: 'account_fixed',
    account_selection: 'buyer_selected',
    supported_timezones: ['UTC'],
  };
  const { options } = timezoneProfile(accountTimezone);
  const syncRequests = [];
  const listRequests = [];
  let syncCount = 0;

  const result = await runStoryboard('https://agent.example/mcp', storyboard, {
    ...options,
    _client: {
      resetContext() {},
      async getAdcpCapabilities() {
        return { success: true, data: capabilityResult(accountTimezone) };
      },
      async syncAccounts(request) {
        syncRequests.push(request);
        const action = syncCount++ === 0 ? 'created' : 'unchanged';
        return {
          success: true,
          data: { status: 'completed', accounts: [accountResult(request.accounts[0], 'UTC', action)] },
        };
      },
      async listAccounts(request) {
        listRequests.push(request);
        return {
          success: true,
          data: { status: 'completed', accounts: [accountResult(request.account, 'UTC')] },
        };
      },
    },
  });

  assert.equal(result.overall_passed, true, JSON.stringify(result, null, 2));
  assert.equal(syncRequests.length, 2);
  assert.equal(listRequests.length, 2);
  assert.deepEqual(syncRequests.map(request => request.accounts[0].timezone), ['UTC', 'UTC']);
  assert.equal(syncRequests[0].accounts[0].operator_unit.id, syncRequests[1].accounts[0].operator_unit.id);
  assert.match(syncRequests[0].accounts[0].operator_unit.id, /^[0-9a-f-]{36}$/);
  assert.equal(syncRequests[0].accounts[0].sandbox, true);
  const expectedNaturalKey = {
    brand: { domain: 'acmeoutdoor.example' },
    operator: 'pinnacle-agency.example',
    operator_unit: { id: syncRequests[0].accounts[0].operator_unit.id },
    timezone: 'UTC',
    sandbox: true,
  };
  assert.deepEqual(listRequests.map(request => request.account), [expectedNaturalKey, expectedNaturalKey]);
  const skippedSwitchPhases = result.phases.filter(phase =>
    ['select_second_timezone', 'verify_both_timezone_keys'].includes(phase.phase_id)
  );
  assert.equal(result.skipped_count, 6);
  assert.deepEqual(
    skippedSwitchPhases.flatMap(phase => phase.steps.map(candidate => candidate.skip_reason)),
    Array(6).fill('not_applicable')
  );
});

test('buyer-selected timezone switch creates a second key without mutating the first', async () => {
  const storyboard = loadExecutable('account_timezone_buyer_selected');
  const accountTimezone = {
    mode: 'account_fixed',
    account_selection: 'buyer_selected',
    supported_timezones: ['America/New_York', 'UTC'],
  };
  const { options } = timezoneProfile(accountTimezone);

  async function execute({ mutateOriginal = false, reuseAccountId = false } = {}) {
    const syncRequests = [];
    const listRequests = [];
    const timezoneByAccountId = new Map();
    let syncCount = 0;
    let secondProvisioned = false;
    const result = await runStoryboard('https://agent.example/mcp', storyboard, {
      ...options,
      _client: {
        resetContext() {},
        async getAdcpCapabilities() {
          return { success: true, data: capabilityResult(accountTimezone) };
        },
        async syncAccounts(request) {
          syncRequests.push(request);
          const action = syncCount++ === 1 ? 'unchanged' : 'created';
          if (request.accounts[0].timezone === 'UTC') secondProvisioned = true;
          return {
            success: true,
            data: {
              status: 'completed',
              accounts: [accountResult(request.accounts[0], request.accounts[0].timezone, action)],
            },
          };
        },
        async listAccounts(request) {
          listRequests.push(request);
          const requestedTimezone =
            request.account.timezone ?? timezoneByAccountId.get(request.account.account_id);
          const returnedTimezone =
            mutateOriginal && secondProvisioned && requestedTimezone === 'America/New_York'
              ? 'UTC'
              : requestedTimezone;
          const account = accountResult(request.account, returnedTimezone);
          if (request.account.account_id) account.account_id = request.account.account_id;
          if (reuseAccountId) account.account_id = 'REUSED-ID';
          timezoneByAccountId.set(account.account_id, returnedTimezone);
          return {
            success: true,
            data: { status: 'completed', accounts: [account] },
          };
        },
      },
    });
    return { result, syncRequests, listRequests };
  }

  const valid = await execute();
  assert.equal(valid.result.overall_passed, true, JSON.stringify(valid.result, null, 2));
  assert.deepEqual(
    valid.syncRequests.map(request => request.accounts[0].timezone),
    ['America/New_York', 'America/New_York', 'UTC']
  );
  assert.deepEqual(
    valid.listRequests.map(request => request.account.timezone),
    ['America/New_York', 'America/New_York', 'America/New_York', 'UTC', undefined, undefined]
  );
  assert.notEqual(
    valid.listRequests[4].account.account_id,
    valid.listRequests[5].account.account_id
  );
  assert.equal(
    new Set(valid.syncRequests.map(request => request.accounts[0].operator_unit.id)).size,
    1
  );

  const mutated = await execute({ mutateOriginal: true });
  assert.equal(mutated.result.overall_passed, false);

  const reusedIdentity = await execute({ reuseAccountId: true });
  assert.equal(reusedIdentity.result.overall_passed, false);
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
