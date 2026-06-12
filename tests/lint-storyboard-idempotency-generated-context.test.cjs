#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lintStoryboardIdempotency } = require('../scripts/build-compliance.cjs');

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
