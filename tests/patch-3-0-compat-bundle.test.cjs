#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const patchScript = path.join(repoRoot, 'scripts', 'patch-3-0-compat-bundle.cjs');

function makeBundle(version, schemaValidationYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-3-0-compat-'));
  const universalDir = path.join(dir, 'universal');
  const mediaBuyScenarioDir = path.join(dir, 'protocols', 'media-buy', 'scenarios');
  const domainsMediaBuyScenarioDir = path.join(dir, 'domains', 'media-buy', 'scenarios');
  fs.mkdirSync(universalDir, { recursive: true });
  fs.mkdirSync(mediaBuyScenarioDir, { recursive: true });
  fs.mkdirSync(domainsMediaBuyScenarioDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ adcp_version: version }), 'utf8');
  fs.writeFileSync(path.join(universalDir, 'idempotency.yaml'), 'id: idempotency\nstart_time: "2026-05-01T00:00:00Z"\n', 'utf8');
  fs.writeFileSync(path.join(universalDir, 'webhook-emission.yaml'), 'id: webhook_emission\n', 'utf8');
  fs.writeFileSync(path.join(universalDir, 'schema-validation.yaml'), schemaValidationYaml, 'utf8');
  fs.writeFileSync(path.join(mediaBuyScenarioDir, 'measurement_terms_rejected.yaml'), 'id: measurement_terms_rejected\n', 'utf8');
  fs.writeFileSync(path.join(domainsMediaBuyScenarioDir, 'measurement_terms_rejected.yaml'), 'id: measurement_terms_rejected\n', 'utf8');
  return dir;
}

test('3.0 compatibility patch expands schema_validation past-start contributions', () => {
  const input = `id: schema_validation
phases:
  - id: past_start_reject_path
    optional: true
    branch_set:
      id: past_start_handled
      semantics: any_of
    steps:
      - id: create_buy_past_start_reject
        task: create_media_buy
        contributes: true
  - id: past_start_adjust_path
    optional: true
    branch_set:
      id: past_start_handled
      semantics: any_of
    steps:
      - id: create_buy_past_start_adjust
        task: create_media_buy
        contributes: true
  - id: past_start_enforcement
    steps:
      - id: assert_past_start_handled
        task: assert_contribution
        validations:
          - check: any_of
            allowed_values: ["past_start_handled"]
`;
  const dir = makeBundle('3.0.14', input);
  try {
    execFileSync(process.execPath, [patchScript, dir], { cwd: repoRoot, encoding: 'utf8' });
    const output = fs.readFileSync(path.join(dir, 'universal', 'schema-validation.yaml'), 'utf8');
    assert.equal(output.includes('        contributes: true\n'), false);
    assert.match(output, /id: create_buy_past_start_reject[\s\S]*contributes_to: past_start_handled/);
    assert.match(output, /id: create_buy_past_start_adjust[\s\S]*contributes_to: past_start_handled/);
    assert.match(output, /id: assert_past_start_handled/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3.0 compatibility patch leaves non-3.0 bundles unchanged', () => {
  const input = `id: schema_validation
phases:
  - id: past_start_reject_path
    optional: true
    branch_set:
      id: past_start_handled
      semantics: any_of
    steps:
      - id: create_buy_past_start_reject
        task: create_media_buy
        contributes: true
`;
  const dir = makeBundle('3.1.0-rc.15', input);
  try {
    execFileSync(process.execPath, [patchScript, dir], { cwd: repoRoot, encoding: 'utf8' });
    const output = fs.readFileSync(path.join(dir, 'universal', 'schema-validation.yaml'), 'utf8');
    assert.equal(output, input);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3.0 compatibility patch moves stale YAML storyboard dates forward', () => {
  const input = `id: schema_validation
phases: []
`;
  const dir = makeBundle('3.0.18', input);
  const scenarioPath = path.join(dir, 'protocols', 'media-buy', 'scenarios', 'measurement_terms_rejected.yaml');
  const domainScenarioPath = path.join(dir, 'domains', 'media-buy', 'scenarios', 'measurement_terms_rejected.yaml');
  const stateMachinePath = path.join(dir, 'protocols', 'media-buy', 'state-machine.yaml');
  const domainStateMachinePath = path.join(dir, 'domains', 'media-buy', 'state-machine.yaml');
  const scenario = `id: media_buy_seller/measurement_terms_rejected
phases:
  - id: reject_terms
    steps:
      - id: create_media_buy_aggressive_terms
        sample_request:
          start_time: "2026-07-01T00:00:00Z"
          end_time: "2026-09-30T23:59:59Z"
          fixed_past_start_time: "2020-01-01T00:00:00Z"
          old_license_end_date: "2024-03-31"
          io_acceptance:
            accepted_at: "2026-03-15T14:30:00Z"
  - id: accept_terms
    steps:
      - id: create_media_buy_relaxed_terms
        sample_request:
          start_time: "2027-07-01T00:00:00Z"
          end_time: "2027-09-30T23:59:59Z"
`;
  const stateMachine = `id: media_buy_state_machine
phases:
  - id: setup
    steps:
      - id: create_buy
        sample_request:
          start_time: "2026-05-01T00:00:00Z"
          end_time: "2026-05-31T23:59:59Z"
        validations:
          - check: field_value
            path: "status"
            value: "active"
`;
  fs.writeFileSync(scenarioPath, scenario, 'utf8');
  fs.writeFileSync(domainScenarioPath, scenario, 'utf8');
  fs.writeFileSync(stateMachinePath, stateMachine, 'utf8');
  fs.writeFileSync(domainStateMachinePath, stateMachine, 'utf8');

  try {
    execFileSync(process.execPath, [patchScript, dir], { cwd: repoRoot, encoding: 'utf8' });
    const output = fs.readFileSync(scenarioPath, 'utf8');
    const domainOutput = fs.readFileSync(domainScenarioPath, 'utf8');
    const idempotencyOutput = fs.readFileSync(path.join(dir, 'universal', 'idempotency.yaml'), 'utf8');
    const stateMachineOutput = fs.readFileSync(stateMachinePath, 'utf8');
    const domainStateMachineOutput = fs.readFileSync(domainStateMachinePath, 'utf8');
    assert.equal(output.includes('2026-07-01T00:00:00Z'), false);
    assert.equal(output.includes('2026-09-30T23:59:59Z'), false);
    assert.equal(output.includes('2027-07-01T00:00:00Z'), false);
    assert.equal(output.includes('2027-09-30T23:59:59Z'), false);
    assert.equal((output.match(/2099-07-01T00:00:00Z/g) ?? []).length, 2);
    assert.equal((output.match(/2099-09-30T23:59:59Z/g) ?? []).length, 2);
    assert.match(output, /fixed_past_start_time: "2020-01-01T00:00:00Z"/);
    assert.match(output, /old_license_end_date: "2024-03-31"/);
    assert.match(output, /accepted_at: "2026-03-15T14:30:00Z"/);
    assert.equal(domainOutput, output);
    assert.match(idempotencyOutput, /start_time: "2099-05-01T00:00:00Z"/);
    assert.match(stateMachineOutput, /start_time: "asap"/);
    assert.match(stateMachineOutput, /end_time: "2099-05-31T23:59:59Z"/);
    assert.match(stateMachineOutput, /path: "media_buy_status"/);
    assert.equal(domainStateMachineOutput, stateMachineOutput);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
