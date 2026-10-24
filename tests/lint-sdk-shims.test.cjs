#!/usr/bin/env node
/**
 * Tests for the SDK shim ledger lint.
 *
 * The important contract is the source-tree guard: new private @adcp/sdk
 * reach-ins must be added to .agents/sdk-shim-ledger.json with ownership,
 * upstream context, and a removal condition.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  loadLedger,
  collectFindings,
  matchingPrivateTerm,
} = require('../scripts/lint-sdk-shims.cjs');

test('source tree private SDK shims are ledgered', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'private SDK shim ledger violations:\n' + violations.map((v) => `  ${v.rule}: ${v.message}`).join('\n'),
  );
});

test('ledger entries include removal conditions and upstream asks', () => {
  const ledger = loadLedger();
  for (const entry of ledger) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.ok(entry.upstream.includes('adcontextprotocol/adcp-client'), entry.id);
    assert.ok(entry.removalCondition.length > 20, entry.id);
    assert.ok(entry.problem.length > 20, entry.id);
  }
});

test('private SDK reach-ins remain bounded to the owned installer and authority regression', () => {
  const findings = collectFindings();
  assert.deepEqual([...new Set(findings.map(finding => finding.file))], ['scripts/install-sdk-creative-build-probe.cjs', 'tests/evaluator-build-probe-authority.test.cjs']);
  assert.ok(findings.every(finding => ['dist/lib/testing/', 'dist/lib/validation/'].some(term => finding.term.includes(term))));
});

test('matchingPrivateTerm ignores comment-only lines but catches private SDK code', () => {
  assert.equal(matchingPrivateTerm('// node_modules/@adcp/sdk/dist/lib/testing/storyboard/compliance.js'), null);
  assert.equal(matchingPrivateTerm('# node_modules/@adcp/sdk/dist/lib/testing/storyboard/compliance.js'), null);
  assert.equal(
    matchingPrivateTerm("const file = 'node_modules/@adcp/sdk/dist/lib/types/schemas.generated.js';"),
    "const file = 'node_modules/@adcp/sdk/dist/lib/types/schemas.generated.js';",
  );
});
