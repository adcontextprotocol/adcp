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
  fs.mkdirSync(universalDir, { recursive: true });
  fs.mkdirSync(mediaBuyScenarioDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ adcp_version: version }), 'utf8');
  fs.writeFileSync(path.join(universalDir, 'idempotency.yaml'), 'id: idempotency\n', 'utf8');
  fs.writeFileSync(path.join(universalDir, 'webhook-emission.yaml'), 'id: webhook_emission\n', 'utf8');
  fs.writeFileSync(path.join(universalDir, 'schema-validation.yaml'), schemaValidationYaml, 'utf8');
  fs.writeFileSync(path.join(mediaBuyScenarioDir, 'measurement_terms_rejected.yaml'), 'id: measurement_terms_rejected\n', 'utf8');
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

test('3.0 compatibility patch moves stale measurement_terms_rejected flight dates forward', () => {
  const input = `id: schema_validation
phases: []
`;
  const dir = makeBundle('3.0.19', input);
  const scenarioPath = path.join(dir, 'protocols', 'media-buy', 'scenarios', 'measurement_terms_rejected.yaml');
  const scenario = `id: media_buy_seller/measurement_terms_rejected
phases:
  - id: reject_terms
    steps:
      - id: create_media_buy_aggressive_terms
        sample_request:
          start_time: "2026-07-01T00:00:00Z"
          end_time: "2026-09-30T23:59:59Z"
  - id: accept_terms
    steps:
      - id: create_media_buy_relaxed_terms
        sample_request:
          start_time: "2026-07-01T00:00:00Z"
          end_time: "2026-09-30T23:59:59Z"
`;
  fs.writeFileSync(scenarioPath, scenario, 'utf8');

  try {
    execFileSync(process.execPath, [patchScript, dir], { cwd: repoRoot, encoding: 'utf8' });
    const output = fs.readFileSync(scenarioPath, 'utf8');
    assert.equal(output.includes('2026-07-01T00:00:00Z'), false);
    assert.equal(output.includes('2026-09-30T23:59:59Z'), false);
    assert.equal((output.match(/2099-07-01T00:00:00Z/g) ?? []).length, 2);
    assert.equal((output.match(/2099-09-30T23:59:59Z/g) ?? []).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
