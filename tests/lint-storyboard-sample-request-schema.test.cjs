#!/usr/bin/env node
/**
 * Wrapper for the storyboard sample_request schema lint. Fails CI on any
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
  fingerprintError,
  formatViolation,
  entryKey,
  isNegativeStep,
  normalizeSubstitutions,
  STORYBOARD_DIR,
} = require('../scripts/lint-storyboard-sample-request-schema.cjs');

test('no storyboard YAML parse errors', async () => {
  const { parseErrors } = await lintAll();
  if (parseErrors.length > 0) {
    const rendered = parseErrors.map((p) => `  ${p.file}: ${p.error}`).join('\n');
    assert.fail(
      `${parseErrors.length} storyboard file(s) failed to parse. Fix the YAML before running lint:\n${rendered}`,
    );
  }
});

test('no new sample_request schema drift beyond the allowlist', async () => {
  const { violations } = await lintAll();
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
  const { violations } = await lintAll();
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
  assert.equal(
    fingerprintError({ keyword: 'const', path: '/refine/0/scope', params: { allowedValue: 'request' } }),
    'const@/refine/0/scope:request',
  );
  assert.equal(
    fingerprintError({ keyword: 'const', path: '/shape', params: { allowedValue: { type: 'object' } } }),
    'const@/shape:{"type":"object"}',
  );
});

// Direct unit tests for the ratchet reducer. The end-to-end tests above prove
// the current tree is clean; these prove the classification logic is honest
// regardless of what the tree happens to contain. If a refactor breaks the
// reducer (entryKey mismatch, fingerprint shape flip, etc.), these fail loudly.
test('reconcileAgainstAllowlist classifies new drift, grandfathered, and stale correctly', () => {
  const file = path.join(STORYBOARD_DIR, 'fixture.yaml');
  const grandfatheredViolation = {
    file,
    phaseId: 'phase_a',
    stepId: 'step_grandfathered',
    schemaRef: 'x/y.json',
    errors: [{ path: '/', keyword: 'required', params: { missingProperty: 'caller' } }],
  };
  const newDriftViolation = {
    file,
    phaseId: 'phase_a',
    stepId: 'step_new',
    schemaRef: 'x/y.json',
    errors: [{ path: '/', keyword: 'required', params: { missingProperty: 'caller' } }],
  };
  const grandfatheredPlusNew = {
    file,
    phaseId: 'phase_b',
    stepId: 'step_mixed',
    schemaRef: 'x/y.json',
    errors: [
      { path: '/', keyword: 'required', params: { missingProperty: 'caller' } },
      { path: '/', keyword: 'additionalProperties', params: { additionalProperty: 'bogus' } },
    ],
  };

  const allowlist = {
    entries: {
      [entryKey(file, 'phase_a', 'step_grandfathered')]: {
        schema: 'x/y.json',
        errors: ['required@/:caller'],
      },
      [entryKey(file, 'phase_b', 'step_mixed')]: {
        schema: 'x/y.json',
        errors: ['required@/:caller'],
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

test('isNegativeStep detects error-path tests via validations and explicit flag', () => {
  assert.equal(isNegativeStep({ validations: [{ check: 'error_code', value: 'VALIDATION_ERROR' }] }), true);
  assert.equal(isNegativeStep({ validations: [{ check: 'http_status_in', allowed_values: [400, 422] }] }), true);
  assert.equal(isNegativeStep({ validations: [{ check: 'http_status_in', allowed_values: ['4xx', '5xx'] }] }), false); // regex requires digits, not wildcards
  assert.equal(isNegativeStep({ validations: [{ check: 'status_code', value: 404 }] }), true);
  assert.equal(isNegativeStep({ sample_request_skip_schema: true }), true);
  assert.equal(isNegativeStep({ validations: [{ check: 'response_schema' }] }), false);
  assert.equal(isNegativeStep({}), false);
});

test('normalizeSubstitutions replaces every live substitution dialect', () => {
  const stringSchema = { type: 'string' };
  // $-prefix forms
  assert.equal(normalizeSubstitutions('$context.plan_id', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('$generate:uuid_v4#tag', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('$test_kit.schemas.primary', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('$from_step:step_a.plan_id', stringSchema), '00000000-0000-4000-8000-000000000000');
  // Handlebars forms
  assert.equal(normalizeSubstitutions('{{runner.webhook_url:step_a}}', stringSchema), '00000000-0000-4000-8000-000000000000');
  assert.equal(normalizeSubstitutions('{{prior_step.step_a.operation_id}}', stringSchema), '00000000-0000-4000-8000-000000000000');
  // Non-substitution literals pass through
  assert.equal(normalizeSubstitutions('plain value', stringSchema), 'plain value');
});
