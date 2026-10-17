'use strict';

// media_buy_seller/total_budget_redistribution grades redistribution, not
// currency selection (that is pricing_currency_filter). The scenario used to
// write `currency: "USD"` into both update_media_buy requests, so a seller
// that commits the buy in its own currency was failed on an update it was
// right to reject — update_media_buy cannot redenominate a buy (#8232).
//
// These tests pin the replacement contract: the currency sent on every
// total_budget comes from the committed buy, read back through the one field
// the schemas actually require, and both an EUR seller and a USD seller pass.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');

const ROOT = path.join(__dirname, '..');
const SCENARIO = path.join(
  ROOT,
  'static',
  'compliance',
  'source',
  'protocols',
  'media-buy',
  'scenarios',
  'total_budget_redistribution.yaml'
);

const readJson = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const scenarioDoc = () => YAML.parse(fs.readFileSync(SCENARIO, 'utf8'));
const stepsOf = doc => doc.phases.flatMap(phase => phase.steps);
const stepOf = (doc, id) => stepsOf(doc).find(candidate => candidate.id === id);

function executableScenario({ hardcodeUpdateCurrency = null } = {}) {
  const storyboard = loadStoryboardFile(SCENARIO);
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      // The stub returns minimal payloads rather than full schema instances.
      // Response-shape grading is covered by lint-storyboard-response-schema
      // and the schema suites; what these tests grade is the currency the
      // runner puts on the wire.
      step.validations = (step.validations ?? []).filter(check => check.check !== 'response_schema');
      // Negative control: restore the pre-fix hardcoded literal.
      if (hardcodeUpdateCurrency && step.sample_request?.total_budget) {
        step.sample_request.total_budget.currency = hardcodeUpdateCurrency;
      }
    }
  }
  return storyboard;
}

const TOOLS = [
  'get_adcp_capabilities',
  'comply_test_controller',
  'sync_accounts',
  'create_media_buy',
  'update_media_buy',
  'get_media_buys',
];

/**
 * A seller that prices only in `sellerCurrency`. It accepts the seed calls but
 * denominates what it seeds in its own currency, commits the buy in that
 * currency, and — like the agent in #8232 — rejects any update whose
 * total_budget.currency is not the buy's. It also looks the buy up by
 * `media_buy_id` and enforces the optimistic-concurrency `revision`, so the
 * scenario cannot lose either of those and still pass here.
 *
 * `announceCurrencyOnCreate` is false for the EUR lane on purpose:
 * create-media-buy-response.json does not require `currency`, so a scenario
 * that captured it from there would fail a conformant seller.
 *
 * `redenominateOnUpdate` makes the seller silently switch the buy's currency
 * while applying the redistribution — the misbehaviour the post-update
 * read-back check exists to catch.
 *
 * `omitCurrencyOnRead` breaks the capture itself, to prove the downstream
 * steps cascade-skip rather than putting an unresolved token on the wire.
 */
function sellerStub({
  sellerCurrency,
  announceCurrencyOnCreate,
  redenominateOnUpdate = null,
  omitCurrencyOnRead = false,
}) {
  const calls = [];
  const BUY_ID = 'mb-total-budget-redistribution';
  const buys = new Map();
  const notFound = field => ({
    success: false,
    status: 'completed',
    data: { errors: [{ code: 'NOT_FOUND', message: `no such media buy`, field }] },
  });

  const client = {
    executeTask: async (task, request) => {
      calls.push({ task, request: structuredClone(request) });
      if (task === 'get_adcp_capabilities') {
        return {
          success: true,
          status: 'completed',
          data: {
            supported_protocols: ['media_buy'],
            media_buy: { features: {} },
            comply_test_controller: {
              scenarios: ['seed_product', 'seed_pricing_option', 'seed_account'],
            },
          },
        };
      }
      if (task === 'comply_test_controller') {
        return {
          success: true,
          status: 'completed',
          data: { success: true, scenario: request.scenario, previous_state: 'absent', current_state: 'seeded' },
        };
      }
      if (task === 'sync_accounts') {
        return {
          success: true,
          status: 'completed',
          data: {
            accounts: [
              {
                account_id: 'acct_total_budget_redistribution',
                brand: request.accounts[0].brand,
                operator: request.accounts[0].operator,
                billing: 'operator',
                currency: sellerCurrency,
                status: 'active',
                action: 'created',
              },
            ],
          },
        };
      }
      if (task === 'create_media_buy') {
        const packages = request.packages.map((pkg, index) => ({
          package_id: `pkg-${index}`,
          product_id: pkg.product_id,
          pricing_option_id: pkg.pricing_option_id,
          budget: pkg.budget,
        }));
        const buy = {
          currency: sellerCurrency,
          packages,
          total: packages.reduce((sum, pkg) => sum + pkg.budget, 0),
          revision: 1,
        };
        buys.set(BUY_ID, buy);
        return {
          success: true,
          status: 'completed',
          data: {
            media_buy_id: BUY_ID,
            media_buy_status: 'pending_creatives',
            confirmed_at: '2099-01-01T00:00:00Z',
            revision: buy.revision,
            total_budget: buy.total,
            ...(announceCurrencyOnCreate && { currency: buy.currency }),
            packages: buy.packages,
          },
        };
      }
      if (task === 'get_media_buys') {
        const buy = buys.get(request.media_buy_ids[0]);
        if (!buy) return notFound('media_buy_ids');
        return {
          success: true,
          status: 'completed',
          data: {
            media_buys: [
              {
                media_buy_id: request.media_buy_ids[0],
                status: 'pending_creatives',
                ...(omitCurrencyOnRead ? {} : { currency: buy.currency }),
                total_budget: buy.total,
                confirmed_at: '2099-01-01T00:00:00Z',
                revision: buy.revision,
                packages: buy.packages,
              },
            ],
          },
        };
      }
      if (task === 'update_media_buy') {
        const buy = buys.get(request.media_buy_id);
        if (!buy) return notFound('media_buy_id');
        if (request.revision !== undefined && request.revision !== buy.revision) {
          return {
            success: false,
            status: 'completed',
            data: { errors: [{ code: 'CONFLICT', message: 'stale revision', field: 'revision' }] },
          };
        }
        const requested = request.total_budget;
        if (requested && requested.currency !== buy.currency) {
          return {
            success: false,
            status: 'completed',
            error: `total_budget.currency ${requested.currency} is not the currency of this media buy (${buy.currency})`,
            data: {
              errors: [
                {
                  code: 'VALIDATION_ERROR',
                  message: 'An update cannot change the currency of a media buy',
                  field: 'total_budget.currency',
                },
              ],
            },
          };
        }
        if (request.packages) {
          // The explicit-package arm: the asserted total must equal the
          // resulting package sum. The scenario deliberately sends one that
          // does not.
          const patched = buy.packages.map(pkg => {
            const patch = request.packages.find(candidate => candidate.package_id === pkg.package_id);
            return patch ? { ...pkg, budget: patch.budget } : pkg;
          });
          const sum = patched.reduce((total, pkg) => total + pkg.budget, 0);
          if (!requested || sum !== requested.amount) {
            return {
              success: false,
              status: 'completed',
              error: 'total_budget does not match the explicit package sum',
              data: {
                errors: [
                  { code: 'VALIDATION_ERROR', message: 'total_budget is inconsistent with packages', field: 'total_budget' },
                ],
              },
            };
          }
        }
        const scale = requested.amount / buy.total;
        buy.packages = buy.packages.map(pkg => ({ ...pkg, budget: pkg.budget * scale }));
        buy.total = requested.amount;
        buy.revision += 1;
        if (redenominateOnUpdate) buy.currency = redenominateOnUpdate;
        return {
          success: true,
          status: 'completed',
          data: {
            media_buy_id: request.media_buy_id,
            revision: buy.revision,
            currency: buy.currency,
            total_budget: buy.total,
            affected_packages: buy.packages,
          },
        };
      }
      throw new Error(`unexpected task ${task}`);
    },
    resetContext: () => {},
  };

  return { client, calls };
}

async function runAgainstSeller({
  sellerCurrency,
  announceCurrencyOnCreate = true,
  hardcodeUpdateCurrency = null,
  redenominateOnUpdate = null,
  omitCurrencyOnRead = false,
}) {
  const { client, calls } = sellerStub({
    sellerCurrency,
    announceCurrencyOnCreate,
    redenominateOnUpdate,
    omitCurrencyOnRead,
  });
  const result = await runStoryboard('https://seller.example/mcp', executableScenario({ hardcodeUpdateCurrency }), {
    protocol: 'mcp',
    agentTools: TOOLS,
    _client: client,
    _profile: { name: `${sellerCurrency} seller`, tools: TOOLS },
  });
  const updates = calls.filter(call => call.task === 'update_media_buy');
  return { result, calls, updates };
}

// A skipped step is still present in result.phases[].steps with passed: true
// and a skip_reason, and overall_passed stays true. Anything claiming a step
// was *graded* has to exclude those explicitly.
function gradedSteps(result) {
  return result.phases
    .filter(phase => phase.phase_id !== '__controller_seeding__')
    .flatMap(phase => phase.steps)
    .filter(step => step.skip_reason === undefined && step.skipped !== true)
    .map(step => step.step_id);
}

// Unfiltered by phase: a seeding failure should surface here too. A
// cascade-skipped step carries passed: false *and* a skip_reason — that is a
// skip, not a grade, so it belongs in skippedSteps.
function failedSteps(result) {
  return result.phases
    .flatMap(phase => phase.steps)
    .filter(step => step.passed === false && step.skip_reason === undefined)
    .map(step => step.step_id);
}

function skippedSteps(result) {
  return result.phases
    .flatMap(phase => phase.steps)
    .filter(step => step.skip_reason !== undefined)
    .map(step => [step.step_id, step.skip_reason]);
}

for (const [currency, announceCurrencyOnCreate] of [
  // The EUR lane omits `currency` from the create response, which
  // create-media-buy-response.json permits. The scenario must still find the
  // buy's currency.
  ['EUR', false],
  ['USD', true],
]) {
  test(`total_budget_redistribution passes against a seller that transacts in ${currency}`, async () => {
    const { result, calls, updates } = await runAgainstSeller({ sellerCurrency: currency, announceCurrencyOnCreate });

    // The fixtures ask for a USD rate card. Whether the seller honoured that
    // or priced in its own currency, the scenario follows the buy.
    const seeded = calls
      .filter(call => call.task === 'comply_test_controller' && call.request.scenario === 'seed_pricing_option')
      .map(call => call.request.params.fixture.currency);
    assert.deepEqual(seeded, ['USD', 'USD'], 'the seeded exemplar is unchanged and single-currency');
    assert.equal(result.overall_passed, true, JSON.stringify(failedSteps(result)));
    assert.deepEqual(
      gradedSteps(result),
      stepsOf(scenarioDoc()).map(step => step.id),
      'every authored step is graded — none of this passes by skipping'
    );
    assert.equal(result.skipped_count, 0, 'no step was skipped');
    assert.deepEqual(skippedSteps(result), []);
    assert.equal(updates.length, 2, 'both the redistribution and the conflict probe reach the seller');
    for (const update of updates) {
      assert.equal(
        update.request.total_budget.currency,
        currency,
        'every total_budget repeats the currency the buy was committed in'
      );
    }
    const doc = scenarioDoc();
    assert.equal(
      updates[0].request.total_budget.amount,
      stepOf(doc, 'update_total_budget').sample_request.total_budget.amount
    );
    assert.equal(
      updates[1].request.total_budget.amount,
      stepOf(doc, 'reject_total_with_packages').sample_request.total_budget.amount
    );
  });
}

test('the pre-fix hardcoded USD literal still fails the EUR seller', async () => {
  const { result, updates } = await runAgainstSeller({
    sellerCurrency: 'EUR',
    announceCurrencyOnCreate: false,
    hardcodeUpdateCurrency: 'USD',
  });
  assert.equal(result.overall_passed, false, 'the negative control must reproduce #8232');
  assert.equal(updates[0].request.total_budget.currency, 'USD');
  // Exactly the two steps the reporter saw fail: the rejected update, and the
  // read-back that consequentially still shows the original total.
  assert.deepEqual(failedSteps(result), ['update_total_budget', 'read_redistributed_budget']);

  // The third symptom, which is why the bug is worse than one red step: the
  // conflict probe goes green on the seller's *currency* rejection rather than
  // on the inconsistent package sum it exists to grade. `error_code:
  // VALIDATION_ERROR` cannot tell the two apart.
  const probe = result.phases
    .flatMap(phase => phase.steps)
    .find(step => step.step_id === 'reject_total_with_packages');
  assert.equal(probe.passed, true, 'the probe passes');
  assert.equal(probe.skip_reason, undefined, 'and it really ran');
  assert.equal(updates[1].request.total_budget.currency, 'USD', 'but on a currency it was never meant to send');
});

test('a seller that redenominates while redistributing is caught', async () => {
  const { result } = await runAgainstSeller({
    sellerCurrency: 'EUR',
    announceCurrencyOnCreate: false,
    redenominateOnUpdate: 'USD',
  });
  assert.equal(result.overall_passed, false, 'an update may not change the currency of a buy');
  assert.deepEqual(
    failedSteps(result),
    ['read_redistributed_budget'],
    'the post-update read-back is what catches it'
  );
});

test('a failed currency capture skips the updates instead of sending a raw token', async () => {
  const { result, updates, calls } = await runAgainstSeller({
    sellerCurrency: 'EUR',
    omitCurrencyOnRead: true,
  });
  assert.equal(result.overall_passed, false);
  assert.deepEqual(
    failedSteps(result),
    ['read_committed_currency', 'read_redistributed_budget'],
    'the capture step owns the contract it declared'
  );

  // The point of the guard: expect_error steps are not skipped on unresolved
  // substitution, so without the cascade the conflict probe would have shipped
  // `"$context.media_buy_currency"` — a value no `^[A-Z]{3}$` field accepts —
  // and passed on the seller's rejection of it.
  assert.equal(updates.length, 0, 'no update_media_buy reached the seller');
  assert.equal(
    JSON.stringify(calls).includes('$context.'),
    false,
    'no unresolved substitution token was ever put on the wire'
  );
  assert.deepEqual(skippedSteps(result), [
    ['update_total_budget', 'prerequisite_failed'],
    ['reject_total_with_packages', 'prerequisite_failed'],
  ]);
});

test('the committed currency is read from the only field the schemas require', () => {
  const getMediaBuys = readJson('static/schemas/source/media-buy/get-media-buys-response.json');
  const mediaBuy = getMediaBuys.properties.media_buys.items;
  assert.ok(
    mediaBuy.required.includes('currency'),
    'get_media_buys is the authoritative read: media_buys[].currency is required'
  );

  const createSuccess = readJson('static/schemas/source/media-buy/create-media-buy-response.json').oneOf.find(
    branch => branch.title === 'CreateMediaBuySuccess'
  );
  assert.equal(
    createSuccess.required.includes('currency'),
    false,
    'create_media_buy MAY omit currency, so capturing it there would fail a conformant seller'
  );

  const updateSuccess = readJson('static/schemas/source/media-buy/update-media-buy-response.json').oneOf.find(
    branch => branch.title === 'UpdateMediaBuySuccess'
  );
  assert.equal(
    updateSuccess.required.includes('currency'),
    false,
    'update_media_buy MAY omit currency, so the scenario asserts it on the get_media_buys read-back'
  );

  const requestCurrency = readJson('static/schemas/source/media-buy/update-media-buy-request.json').properties
    .total_budget;
  assert.ok(requestCurrency.required.includes('currency'), 'the scenario cannot simply drop the field');
  assert.match(requestCurrency.description, /currency MUST equal the existing media-buy currency/);
});

test('no step hardcodes a currency into a total_budget it sends', () => {
  const doc = scenarioDoc();

  const capture = stepOf(doc, 'read_committed_currency');
  assert.equal(capture.task, 'get_media_buys');
  assert.deepEqual(capture.context_outputs, [{ name: 'media_buy_currency', path: 'media_buys[0].currency' }]);
  // The capture step must keep schema-grading the response it captures from:
  // response_schema is what pins the value to `^[A-Z]{3}$` before it reaches
  // two request bodies.
  assert.ok(
    capture.validations.some(check => check.check === 'response_schema'),
    'the capture step schema-grades the response it captures from'
  );

  for (const step of stepsOf(doc)) {
    const currency = step.sample_request?.total_budget?.currency;
    if (currency === undefined) continue;
    assert.equal(
      currency,
      '$context.media_buy_currency',
      `${step.id} must carry the committed currency, not a literal`
    );
  }

  const readback = stepOf(doc, 'read_redistributed_budget');
  assert.ok(
    readback.validations.some(
      check =>
        check.check === 'field_value' &&
        check.path === 'media_buys[0].currency' &&
        check.value === '$context.media_buy_currency'
    ),
    'the read-back asserts the redistribution did not redenominate the buy'
  );

  // Currency selection is graded elsewhere; this scenario must not grow a gate
  // at any scope — a phase gate would hide it from the same sellers.
  assert.equal(doc.requires_capability, undefined);
  assert.equal(doc.requires_all_capabilities, undefined);
  for (const phase of doc.phases) {
    assert.equal(phase.requires_capability, undefined, `${phase.id} is ungated`);
    assert.equal(phase.requires_all_capabilities, undefined, `${phase.id} is ungated`);
  }

  // expect_error steps are NOT skipped on unresolved $context substitution, so
  // the conflict probe would otherwise send the raw token and pass on the
  // seller's rejection of *that*. stateful + depends_on make it cascade-skip
  // when the capture it depends on failed, while keeping it graded when only
  // the redistribute phase tripped.
  const probe = stepOf(doc, 'reject_total_with_packages');
  assert.equal(probe.stateful, true);
  assert.equal(capture.stateful, true);
  assert.deepEqual(
    doc.phases.find(phase => phase.id === 'reject_ambiguous_update').depends_on,
    ['setup']
  );

  // get_media_buys writes `revision` by convention, so the create capture must
  // not use that key or the read would overwrite what create_media_buy returned.
  const create = stepOf(doc, 'create_fixed_buy');
  assert.equal(create.context_outputs.some(output => output.name === 'revision'), false);
  assert.equal(
    stepOf(doc, 'update_total_budget').sample_request.revision,
    `$context.${create.context_outputs.find(output => output.path === 'revision').name}`
  );
});
