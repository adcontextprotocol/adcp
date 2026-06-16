#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lintStoryboardIdempotency } = require('../scripts/build-compliance.cjs');
const {
  injectContext,
  parseStoryboard,
} = require('@adcp/client/testing');

function makeFixture(storyboardYaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-idem-lint-'));
  const sourceDir = path.join(root, 'source');
  const schemasDir = path.join(root, 'schemas');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(path.join(schemasDir, 'media-buy'), { recursive: true });
  fs.writeFileSync(
    path.join(schemasDir, 'media-buy', 'create-media-buy-request.json'),
    JSON.stringify({
      type: 'object',
      required: ['idempotency_key'],
      properties: { idempotency_key: { type: 'string' } },
    }),
  );
  fs.writeFileSync(path.join(sourceDir, 'fixture.yaml'), storyboardYaml);
  return { root, sourceDir, schemasDir };
}

test('idempotency lint accepts generated UUID context after the generating step', () => {
  const { root, sourceDir, schemasDir } = makeFixture(`
phases:
  - id: discovery
    steps:
      - id: capabilities
        task: get_adcp_capabilities
        context_outputs:
          - name: replay_key
            generate: uuid_v4
  - id: mutate
    steps:
      - id: create
        task: create_media_buy
        schema_ref: "media-buy/create-media-buy-request.json"
        sample_request:
          idempotency_key: "$context.replay_key"
`);
  try {
    assert.doesNotThrow(() => lintStoryboardIdempotency(sourceDir, schemasDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('idempotency lint rejects generated UUID context before the generating step', () => {
  const { root, sourceDir, schemasDir } = makeFixture(`
phases:
  - id: mutate
    steps:
      - id: create
        task: create_media_buy
        schema_ref: "media-buy/create-media-buy-request.json"
        sample_request:
          idempotency_key: "$context.replay_key"
      - id: capabilities
        task: get_adcp_capabilities
        context_outputs:
          - name: replay_key
            generate: uuid_v4
`);
  try {
    assert.throws(
      () => lintStoryboardIdempotency(sourceDir, schemasDir),
      /use stable authored idempotency_key values/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source idempotency storyboard reuses one replay key across replay steps', () => {
  const storyboardPath = path.join(
    __dirname,
    '..',
    'static/compliance/source/universal/idempotency.yaml',
  );
  const storyboard = parseStoryboard(fs.readFileSync(storyboardPath, 'utf8'), storyboardPath);
  const capabilityStep = storyboard.phases
    .find(phase => phase.id === 'capability_discovery')
    ?.steps.find(step => step.id === 'get_capabilities');
  assert.ok(capabilityStep, 'capability_discovery/get_capabilities step should exist');

  assert.deepEqual(
    capabilityStep.context_outputs
      .filter(output => output.generate === 'uuid_v4')
      .map(output => output.name)
      .sort(),
    ['fresh_key', 'replay_key'],
  );

  const context = {
    replay_key: '11111111-1111-4111-8111-111111111111',
    fresh_key: '22222222-2222-4222-8222-222222222222',
  };

  const replaySteps = storyboard.phases
    .find(phase => phase.id === 'replay_same_payload')
    ?.steps.filter(step => [
      'create_media_buy_initial',
      'create_media_buy_replay',
      'create_media_buy_conflict',
    ].includes(step.id));
  assert.equal(replaySteps?.length, 3, 'expected all replay_same_payload steps');

  const requests = replaySteps.map(step => injectContext(step.sample_request, context));
  assert.equal(requests[0].idempotency_key, context.replay_key);
  assert.equal(requests[0].idempotency_key, requests[1].idempotency_key);
  assert.equal(requests[0].idempotency_key, requests[2].idempotency_key);

  const freshStep = storyboard.phases
    .find(phase => phase.id === 'fresh_key_new_resource')
    ?.steps.find(step => step.id === 'create_media_buy_fresh_key');
  assert.ok(freshStep, 'fresh_key_new_resource/create_media_buy_fresh_key step should exist');
  const freshRequest = injectContext(freshStep.sample_request, context);
  assert.equal(freshRequest.idempotency_key, context.fresh_key);
  assert.notEqual(freshRequest.idempotency_key, requests[0].idempotency_key);
});
