#!/usr/bin/env node
/**
 * Wrapper for the storyboard sample_request schema lint. Fails CI on any
 * new drift beyond the known-issues allowlist or on stale entries that
 * were never removed after a fix.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  lintAll,
  loadAllowlist,
  reconcileAgainstAllowlist,
  fingerprintError,
  formatViolation,
} = require('../scripts/lint-storyboard-sample-request-schema.cjs');

test('no new sample_request schema drift beyond the allowlist', async () => {
  const violations = await lintAll();
  const allowlist = loadAllowlist();
  const { newDrift } = reconcileAgainstAllowlist(violations, allowlist);
  if (newDrift.length > 0) {
    const rendered = newDrift.map(formatViolation).join('\n');
    assert.fail(
      `${newDrift.length} step(s) have sample_request schema drift that is not in the allowlist.\n` +
        'Fix the fixture to match the schema, or (rarely) regenerate the allowlist if the drift is deliberate and pending a fix:\n' +
        '  node scripts/lint-storyboard-sample-request-schema.cjs --write-allowlist\n\n' +
        rendered,
    );
  }
});

test('allowlist has no stale entries', async () => {
  const violations = await lintAll();
  const allowlist = loadAllowlist();
  const { stale } = reconcileAgainstAllowlist(violations, allowlist);
  if (stale.length > 0) {
    const rendered = stale.map((s) => `  ${s.key}`).join('\n');
    assert.fail(
      `${stale.length} allowlist entr${stale.length === 1 ? 'y is' : 'ies are'} stale — the drift was fixed but the entry was not removed.\n` +
        'Regenerate the allowlist:\n' +
        '  node scripts/lint-storyboard-sample-request-schema.cjs --write-allowlist\n\n' +
        rendered,
    );
  }
});

test('fingerprintError produces stable output for common error shapes', () => {
  assert.equal(
    fingerprintError({ keyword: 'required', path: '/', params: { missingProperty: 'caller' } }),
    'required@/:caller',
  );
  assert.equal(
    fingerprintError({ keyword: 'additionalProperties', path: '/account', params: { additionalProperty: 'scheme' } }),
    'additionalProperties@/account:scheme',
  );
  assert.equal(
    fingerprintError({ keyword: 'type', path: '/outcome', params: { type: 'string' } }),
    'type@/outcome:string',
  );
});
