'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('yaml');
const { injectContext, runValidations } = require('@adcp/sdk/testing');

const storyboard = yaml.parse(fs.readFileSync(path.join(__dirname,
  '../static/compliance/source/protocols/media-buy/scenarios/terminal_package_retention.yaml'), 'utf8'));
const steps = storyboard.phases.flatMap(phase => phase.steps);
const originalCancellation = {
  canceled_at: '2026-10-15T10:00:00Z',
  canceled_by: 'buyer',
  reason: 'First line canceled before the whole buy',
};

function readback(status = 'canceled') {
  const buy = structuredClone(storyboard.fixtures.media_buys[0]);
  buy.status = status;
  buy.packages[0].cancellation = structuredClone(originalCancellation);
  buy.packages[1].budget = 4000;
  return { adcp_version: '3.3', status: 'completed', media_buys: [buy] };
}

function grade(stepId, data) {
  const step = steps.find(candidate => candidate.id === stepId);
  const context = { original_package_canceled_at: originalCancellation.canceled_at };
  const validations = step.validations
    .filter(validation => validation.check !== 'response_schema')
    .map(validation => ({
      ...validation,
      ...(validation.value !== undefined && {
        value: injectContext({ value: validation.value }, context).value,
      }),
    }));
  return runValidations(validations, {
    taskName: step.task,
    taskResult: { success: true, data },
    agentUrl: 'https://seller.example/mcp',
    contributions: new Set(),
    request: {},
    storyboardContext: context,
  });
}

function passes(stepId, data) {
  return grade(stepId, data).every(validation => validation.passed);
}

test('retention checks accept stable, beta, and RC releases with either package order and no snapshots', () => {
  for (const [stepId, status] of [
    ['read_after_package_cancel', 'pending_creatives'],
    ['read_after_buy_cancel', 'canceled'],
  ]) {
    const data = readback(status);
    assert.equal(passes(stepId, data), true, JSON.stringify(grade(stepId, data)));
    for (const pkg of data.media_buys[0].packages) {
      if (pkg.cancellation) delete pkg.cancellation.reason;
    }
    assert.equal(passes(stepId, data), true, 'optional cancellation reasons and canceled flags may be absent');
    data.media_buys[0].packages.reverse();
    assert.equal(passes(stepId, data), true, JSON.stringify(grade(stepId, data)));
    for (const adcpVersion of ['3.3', '3.3-beta.0', '3.3-rc.0']) {
      data.adcp_version = adcpVersion;
      assert.equal(passes(stepId, data), true, adcpVersion);
      assert.equal(passes('read_recorded_buy', {
        adcp_version: adcpVersion,
        status: 'completed',
        media_buys: [structuredClone(storyboard.fixtures.media_buys[0])],
      }), true, `initial read: ${adcpVersion}`);
    }
  }
});

test('retention checks reject empty, partial, and substituted package lists', () => {
  for (const packages of [[], [readback().media_buys[0].packages[0]]]) {
    const data = readback();
    data.media_buys[0].packages = packages;
    assert.equal(passes('read_after_buy_cancel', data), false);
  }
  for (const field of ['package_id', 'product_id', 'context']) {
    const data = readback();
    data.media_buys[0].packages[1][field] = field === 'context'
      ? { buyer_ref: 'wrong-buyer-line' }
      : 'substituted-identity';
    assert.equal(passes('read_after_buy_cancel', data), false, field);
  }
});

test('both cancellation reads reject a stale creation-time package budget', () => {
  for (const [stepId, status] of [
    ['read_after_package_cancel', 'pending_creatives'],
    ['read_after_buy_cancel', 'canceled'],
  ]) {
    const data = readback(status);
    data.media_buys[0].packages[1].budget = 5000;
    assert.equal(passes(stepId, data), false, stepId);
  }
});

test('whole-buy read rejects rewritten or missing original package cancellation metadata', () => {
  for (const replacement of [
    undefined,
    { ...originalCancellation, canceled_at: '2026-10-15T12:00:00Z' },
    { ...originalCancellation, canceled_by: 'seller' },
  ]) {
    const data = readback();
    data.media_buys[0].packages[0].cancellation = replacement;
    assert.equal(passes('read_after_buy_cancel', data), false, JSON.stringify(replacement));
  }
});

test('whole-buy read rejects a different buy, nonterminal status, or a downshifted release', () => {
  for (const mutate of [
    data => { data.media_buys[0].media_buy_id = 'different-buy'; },
    data => { data.media_buys[0].status = 'paused'; },
    data => { data.adcp_version = '3.2'; },
    data => { delete data.adcp_version; },
  ]) {
    const data = readback();
    mutate(data);
    assert.equal(passes('read_after_buy_cancel', data), false);
  }
});

test('individual cancellation capture records the timestamp used by later membership checks', () => {
  const cancel = steps.find(step => step.id === 'cancel_first_package');
  assert.equal(cancel.context_outputs[0].path, 'affected_packages[0].cancellation.canceled_at');
  assert.equal(cancel.context_outputs[0].key, 'original_package_canceled_at');
  const response = {
    media_buy_id: 'mb_terminal_package_retention',
    affected_packages: [{
      package_id: 'pkg_retention_first',
      cancellation: { ...originalCancellation },
    }],
  };
  assert.equal(passes('cancel_first_package', response), true);
  delete response.affected_packages[0].cancellation.canceled_at;
  assert.equal(passes('cancel_first_package', response), false);
});
