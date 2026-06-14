#!/usr/bin/env node
/**
 * Tests for the test-kits bimodal-partition lint. Two concerns:
 *   1. Source-tree guard — every real test kit under static/compliance/source/
 *      test-kits/ passes the lint. Prevents regression when someone adds a
 *      kit without any partition marker.
 *   2. Per-rule coverage — `kit_shape_unclassified` fires on a synthetic kit
 *      that declares neither marker; does NOT fire on brand-only, runner-
 *      only, or hybrid (both-markers) shapes.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, classify, RULE_MESSAGES } = require('../scripts/lint-storyboard-test-kits.cjs');

test('source tree passes the test-kits lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real test kits violate the bimodal partition:\n' +
      violations.map((v) => `  ${v.file} — ${v.rule}`).join('\n'),
  );
});

test('classify: brand kit (auth.api_key only)', () => {
  const { hasApiKey, hasBasic, hasAppliesTo } = classify({ auth: { api_key: 'demo-x-v1' } });
  assert.equal(hasApiKey, true);
  assert.equal(hasBasic, false);
  assert.equal(hasAppliesTo, false);
});

test('classify: brand kit (auth.basic username/password only)', () => {
  const { hasApiKey, hasBasic, hasAppliesTo } = classify({
    auth: { basic: { username: 'demo-user', password: 'demo-password' } },
  });
  assert.equal(hasApiKey, false);
  assert.equal(hasBasic, true);
  assert.equal(hasAppliesTo, false);
});

test('classify: brand kit (auth.basic credentials only)', () => {
  const { hasApiKey, hasBasic, hasAppliesTo } = classify({
    auth: { basic: { credentials: 'demo-user:demo-password' } },
  });
  assert.equal(hasApiKey, false);
  assert.equal(hasBasic, true);
  assert.equal(hasAppliesTo, false);
});

test('classify: malformed auth.basic shapes do not count as brand kits', () => {
  const cases = [
    { auth: { basic: { credentials: 'demo-user' } } },
    { auth: { basic: { credentials: ':demo-password' } } },
    { auth: { basic: { credentials: 'demo-user:' } } },
    { auth: { basic: { username: 'demo-user' } } },
    { auth: { basic: { password: 'demo-password' } } },
    { auth: { basic: { username: '', password: 'demo-password' } } },
    { auth: { basic: { username: 'demo-user', password: '' } } },
    { auth: { basic: { username: 'demo\nuser', password: 'demo-password' } } },
  ];
  for (const doc of cases) {
    const { hasApiKey, hasBasic, hasAppliesTo } = classify(doc);
    assert.equal(hasApiKey, false);
    assert.equal(hasBasic, false);
    assert.equal(hasAppliesTo, false);
  }
});

test('classify: runner contract (applies_to only)', () => {
  const { hasApiKey, hasBasic, hasAppliesTo } = classify({ applies_to: { universal_storyboard: 'signed-requests' } });
  assert.equal(hasApiKey, false);
  assert.equal(hasBasic, false);
  assert.equal(hasAppliesTo, true);
});

test('classify: hybrid (future branded-runner — both markers)', () => {
  const { hasApiKey, hasBasic, hasAppliesTo } = classify({
    auth: { api_key: 'demo-x-v1' },
    applies_to: { universal_storyboard: 'signed-requests' },
  });
  assert.equal(hasApiKey, true);
  assert.equal(hasBasic, false);
  assert.equal(hasAppliesTo, true);
});

test('classify: unclassified (neither marker)', () => {
  const { hasApiKey, hasBasic, hasAppliesTo } = classify({ id: 'orphan', name: 'Orphan Kit' });
  assert.equal(hasApiKey, false);
  assert.equal(hasBasic, false);
  assert.equal(hasAppliesTo, false);
});

test('classify: defensive — null / non-object doc', () => {
  assert.deepEqual(classify(null), { hasApiKey: false, hasBasic: false, hasAppliesTo: false });
  assert.deepEqual(classify('string-not-object'), { hasApiKey: false, hasBasic: false, hasAppliesTo: false });
});

test('classify: auth without api_key does not count as brand', () => {
  // `auth: { probe_task: list_creatives }` alone (no credential) is an
  // incomplete brand kit. The probe_task field is meaningless without a
  // credential to sign probes with. Must not classify as brand-flavored.
  const { hasApiKey, hasBasic } = classify({ auth: { probe_task: 'list_creatives' } });
  assert.equal(hasApiKey, false);
  assert.equal(hasBasic, false);
});

test('lint() fires kit_shape_unclassified on a synthetic tree with one orphan kit', () => {
  // End-to-end: drop credential-carrying kit files plus one orphan with no
  // marker and assert lint() flags only the orphan with the expected
  // `{file, rule}` shape.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-kits-lint-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'good-brand.yaml'),
      `
id: good_brand
auth:
  api_key: "demo-good-v1"
brand:
  house:
    domain: "good.example"
`,
    );
    fs.writeFileSync(
      path.join(tmp, 'good-basic.yaml'),
      `
id: good_basic
auth:
  basic:
    username: "demo-user"
    password: "demo-password"
brand:
  house:
    domain: "good-basic.example"
`,
    );
    fs.writeFileSync(
      path.join(tmp, 'orphan.yaml'),
      `
id: orphan
name: "Orphan Kit"
description: "Neither marker declared"
`,
    );
    const violations = lint(tmp);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'orphan.yaml');
    assert.equal(violations[0].rule, 'kit_shape_unclassified');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('RULE_MESSAGES.kit_shape_unclassified points authors at the schema docs', () => {
  // Authoring-UX anchor: the error must tell the author where to read about
  // the two flavors. If the schema-docs pointer drifts out of the message,
  // the error becomes uselessly terse.
  const msg = RULE_MESSAGES.kit_shape_unclassified();
  assert.match(msg, /auth\.api_key/);
  assert.match(msg, /auth\.basic/);
  assert.match(msg, /applies_to/);
  assert.match(msg, /storyboard-schema\.yaml/);
});
