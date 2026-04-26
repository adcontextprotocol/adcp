#!/usr/bin/env node
/**
 * Wrapper for the storyboard sample_response schema lint. Fails CI on any
 * new drift beyond the known-issues allowlist or on stale entries that
 * were never removed after a fix.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');

const {
  lintAll,
  loadAllowlist,
  reconcileAgainstAllowlist,
  validateStep,
  fingerprintError,
  formatViolation,
  entryKey,
  STORYBOARD_DIR,
} = require('../scripts/lint-storyboard-response-schema.cjs');

test('no storyboard YAML parse errors', async () => {
  const { parseErrors } = await lintAll();
  if (parseErrors.length > 0) {
    const rendered = parseErrors.map((p) => `  ${p.file}: ${p.error}`).join('\n');
    assert.fail(
      `${parseErrors.length} storyboard file(s) failed to parse. Fix the YAML before running lint:\n${rendered}`,
    );
  }
});

test('no new sample_response schema drift beyond the allowlist', async () => {
  const { violations } = await lintAll();
  const allowlist = loadAllowlist();
  const { newDrift } = reconcileAgainstAllowlist(violations, allowlist);
  if (newDrift.length > 0) {
    const rendered = newDrift.map(formatViolation).join('\n');
    assert.fail(
      `${newDrift.length} step(s) have sample_response schema drift that is not in the allowlist.\n` +
        'Fix the fixture to match the schema, or (rarely) regenerate the allowlist if the drift is deliberate and pending a fix:\n' +
        '  node scripts/lint-storyboard-response-schema.cjs --write-allowlist\n\n' +
        rendered,
    );
  }
});

test('allowlist has no stale entries', async () => {
  const { violations } = await lintAll();
  const allowlist = loadAllowlist();
  const { stale } = reconcileAgainstAllowlist(violations, allowlist);
  if (stale.length > 0) {
    const rendered = stale.map((s) => `  ${s.key}`).join('\n');
    assert.fail(
      `${stale.length} allowlist entr${stale.length === 1 ? 'y is' : 'ies are'} stale — the drift was fixed but the entry was not removed.\n` +
        'Regenerate the allowlist:\n' +
        '  node scripts/lint-storyboard-response-schema.cjs --write-allowlist\n\n' +
        rendered,
    );
  }
});

test('validateStep: schema_not_found is a hard fail, not a soft skip', async () => {
  const result = await validateStep({ schemaRef: 'does/not/exist.json', payload: {} });
  assert.equal(result.ok, false, 'schema_not_found must not be ok:true');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].keyword, 'schema_not_found');
});

test('fingerprintError produces stable output for common error shapes', () => {
  assert.equal(
    fingerprintError({ keyword: 'required', path: '/', params: { missingProperty: 'creatives' } }),
    'required@/:creatives',
  );
  assert.equal(
    fingerprintError({ keyword: 'additionalProperties', path: '/pagination', params: { additionalProperty: 'next_token' } }),
    'additionalProperties@/pagination:next_token',
  );
  assert.equal(
    fingerprintError({ keyword: 'type', path: '/pagination/has_more', params: { type: 'boolean' } }),
    'type@/pagination/has_more:boolean',
  );
  assert.equal(
    fingerprintError({ keyword: 'const', path: '/status', params: { allowedValue: 'approved' } }),
    'const@/status:approved',
  );
  assert.equal(
    fingerprintError({ keyword: 'const', path: '/shape', params: { allowedValue: { type: 'object' } } }),
    'const@/shape:{"type":"object"}',
  );
});

// Direct unit tests for the ratchet reducer. The end-to-end tests above prove
// the current tree is clean; these prove the classification logic is honest
// regardless of what the tree happens to contain.
test('reconcileAgainstAllowlist classifies new drift, grandfathered, and stale correctly', () => {
  const file = path.join(STORYBOARD_DIR, 'fixture.yaml');
  const grandfatheredViolation = {
    file,
    phaseId: 'phase_a',
    stepId: 'step_grandfathered',
    schemaRef: 'x/y.json',
    errors: [{ path: '/', keyword: 'required', params: { missingProperty: 'creatives' } }],
  };
  const newDriftViolation = {
    file,
    phaseId: 'phase_a',
    stepId: 'step_new',
    schemaRef: 'x/y.json',
    errors: [{ path: '/', keyword: 'required', params: { missingProperty: 'creatives' } }],
  };
  const grandfatheredPlusNew = {
    file,
    phaseId: 'phase_b',
    stepId: 'step_mixed',
    schemaRef: 'x/y.json',
    errors: [
      { path: '/', keyword: 'required', params: { missingProperty: 'creatives' } },
      { path: '/', keyword: 'additionalProperties', params: { additionalProperty: 'bogus' } },
    ],
  };

  const allowlist = {
    entries: {
      [entryKey(file, 'phase_a', 'step_grandfathered')]: {
        schema: 'x/y.json',
        errors: ['required@/:creatives'],
      },
      [entryKey(file, 'phase_b', 'step_mixed')]: {
        schema: 'x/y.json',
        errors: ['required@/:creatives'],
      },
      [entryKey(file, 'phase_a', 'step_fixed_but_listed')]: {
        schema: 'x/y.json',
        errors: ['required@/:something'],
      },
    },
  };

  const { newDrift, stale, grandfathered } = reconcileAgainstAllowlist(
    [grandfatheredViolation, newDriftViolation, grandfatheredPlusNew],
    allowlist,
  );

  assert.equal(grandfathered.length, 1, 'pure grandfathered violation classified');
  assert.equal(newDrift.length, 2, 'brand-new step and new error on listed step both count as drift');
  const newDriftSteps = newDrift.map((v) => v.stepId).sort();
  assert.deepEqual(newDriftSteps, ['step_mixed', 'step_new']);
  const mixedOnly = newDrift.find((v) => v.stepId === 'step_mixed');
  assert.equal(mixedOnly.errors.length, 1, 'only the unexpected error is kept on a mixed step');
  assert.equal(mixedOnly.errors[0].keyword, 'additionalProperties');

  assert.equal(stale.length, 1, 'allowlist entry with no matching violation is stale');
  assert.ok(stale[0].key.endsWith('#phase_a/step_fixed_but_listed'));
});
