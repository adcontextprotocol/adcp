#!/usr/bin/env node
/**
 * Tests for the storyboard validations[].path lint (companion to
 * lint-storyboard-context-output-paths.test.cjs). Concerns:
 *   1. Source-tree guard — every real storyboard under
 *      static/compliance/source passes the lint. Regression guard.
 *   2. The `path_not_in_schema` rule fires when a path-bearing check
 *      asserts on a path that doesn't resolve in the response schema.
 *   3. Non-path-bearing checks (error_code, response_schema, http_status,
 *      etc.) are silently skipped — they have no path to validate.
 *   4. The path resolver follows $ref / oneOf / anyOf / allOf / items.
 *   5. Pure extension points (additionalProperties: true with no
 *      properties / variants — like core/context.json and error.details)
 *      accept any further segments without flagging.
 *   6. The allowlist mechanism suppresses entries with documented reasons.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  lintDoc,
  pathResolves,
  pathResolvesAgainstResponseOrEnvelope,
  parsePath,
  loadSchema,
  loadAllowlist,
  isEnvelopeProperty,
  PATH_BEARING_CHECKS,
} = require('../scripts/lint-storyboard-validations-paths.cjs');

test('source tree passes the validations-path lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have validations[].path violations:\n' +
      violations
        .map((v) => `  ${v.filePath}:${v.stepId} — ${v.validationPath} (${v.rule})`)
        .join('\n'),
  );
});

test('path_not_in_schema fires for typo on field_present check', () => {
  const doc = {
    phases: [
      {
        id: 'p',
        steps: [
          {
            id: 'create_buy',
            task: 'create_media_buy',
            response_schema_ref: 'media-buy/create-media-buy-response.json',
            validations: [
              { check: 'field_present', path: 'media_buy_oid', description: 'typo' },
            ],
          },
        ],
      },
    ],
  };

  const violations = lintDoc(doc, '/synth/test.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'path_not_in_schema');
  assert.equal(violations[0].validationPath, 'media_buy_oid');
  assert.equal(violations[0].check, 'field_present');
});

test('path_not_in_schema does not fire for field_present on a defined property', () => {
  const doc = {
    phases: [
      {
        id: 'p',
        steps: [
          {
            id: 'create_buy',
            task: 'create_media_buy',
            response_schema_ref: 'media-buy/create-media-buy-response.json',
            validations: [
              { check: 'field_present', path: 'media_buy_id', description: 'real field' },
            ],
          },
        ],
      },
    ],
  };

  const violations = lintDoc(doc, '/synth/test.yaml');
  assert.deepEqual(violations, []);
});

test('non-path-bearing checks are silently skipped', () => {
  const doc = {
    phases: [
      {
        id: 'p',
        steps: [
          {
            id: 's',
            task: 'create_media_buy',
            response_schema_ref: 'media-buy/create-media-buy-response.json',
            validations: [
              { check: 'response_schema', description: 'no path' },
              { check: 'error_code', value: 'INVALID_REQUEST' },
              { check: 'http_status', value: 200 },
              { check: 'http_status_in', allowed_values: [200, 202] },
              { check: 'any_of', clauses: [] },
              { check: 'on_401_require_header' },
            ],
          },
        ],
      },
    ],
  };

  const violations = lintDoc(doc, '/synth/test.yaml');
  assert.deepEqual(violations, []);
});

test('pure extension points (context.correlation_id) accept any further segments', () => {
  const doc = {
    phases: [
      {
        id: 'p',
        steps: [
          {
            id: 's',
            task: 'create_media_buy',
            response_schema_ref: 'media-buy/create-media-buy-response.json',
            validations: [
              {
                check: 'field_value',
                path: 'context.correlation_id',
                value: 'test-correlation-id',
              },
              {
                check: 'field_value',
                path: 'context.session_id.nested.deeper',
                value: 'whatever',
              },
            ],
          },
        ],
      },
    ],
  };

  const violations = lintDoc(doc, '/synth/test.yaml');
  assert.deepEqual(violations, []);
});

test('pure extension points only loosen when there are no defined properties', () => {
  // si-get-offering-response.json has properties (available, offering_token,
  // etc.) AND additionalProperties: true. That's mixed — strict rule applies
  // because the schema declares specific fields, and `additionalProperties:
  // true` is forward-compat extension, not an open container.
  const schema = loadSchema('sponsored-intelligence/si-get-offering-response.json');
  assert.ok(schema, 'fixture loads');
  // `offering.offering_id` resolves through a defined property
  assert.equal(pathResolves(schema, parsePath('offering.offering_id')), true);
  // `not_a_real_field` does NOT resolve — additionalProperties: true at the
  // root doesn't make typos legal because `properties` is non-empty
  assert.equal(pathResolves(schema, parsePath('not_a_real_field')), false);
});

test('pathResolves descends through error.json $ref for errors[0].code', () => {
  const schema = loadSchema('media-buy/create-media-buy-response.json');
  assert.equal(pathResolves(schema, parsePath('errors[0].code')), true);
  assert.equal(pathResolves(schema, parsePath('errors[0].field')), true);
});

test('envelope-aware resolution: replayed and adcp_error resolve via protocol-envelope.json', () => {
  // Both fields are defined on core/protocol-envelope.json (replayed line 30,
  // adcp_error added in this PR). The envelope's top-level description states
  // "Task response schemas should NOT include these fields - they are
  // protocol-level concerns," so they don't appear on per-task response
  // schemas. The lint falls back to the envelope when a top-level segment
  // isn't found in the payload schema.
  const schema = loadSchema('media-buy/create-media-buy-response.json');
  assert.equal(
    pathResolvesAgainstResponseOrEnvelope(schema, parsePath('replayed')),
    true,
    'replayed should resolve via envelope fallback',
  );
  assert.equal(
    pathResolvesAgainstResponseOrEnvelope(schema, parsePath('adcp_error.code')),
    true,
    'adcp_error.code should resolve via envelope fallback into core/error.json',
  );
  assert.equal(
    pathResolvesAgainstResponseOrEnvelope(schema, parsePath('status')),
    true,
    'status should resolve via envelope fallback',
  );
});

test('isEnvelopeProperty identifies envelope fields', () => {
  assert.equal(isEnvelopeProperty('replayed'), true);
  assert.equal(isEnvelopeProperty('adcp_error'), true);
  assert.equal(isEnvelopeProperty('status'), true);
  assert.equal(isEnvelopeProperty('task_id'), true);
  assert.equal(isEnvelopeProperty('context_id'), true);
  assert.equal(isEnvelopeProperty('made_up_field'), false);
});

test('envelope fallback only fires when first segment is an envelope property', () => {
  // A typo on a non-envelope-shaped path should still fail — the envelope
  // fallback is keyed on the first segment matching an envelope property.
  const schema = loadSchema('media-buy/create-media-buy-response.json');
  assert.equal(
    pathResolvesAgainstResponseOrEnvelope(schema, parsePath('definitely_not_real')),
    false,
    'non-envelope typos should still fail',
  );
});

test('PATH_BEARING_CHECKS is the documented set', () => {
  assert.ok(PATH_BEARING_CHECKS.has('field_present'));
  assert.ok(PATH_BEARING_CHECKS.has('field_value'));
  assert.ok(PATH_BEARING_CHECKS.has('field_value_or_absent'));
  assert.ok(PATH_BEARING_CHECKS.has('field_absent'));
  assert.ok(!PATH_BEARING_CHECKS.has('error_code'));
  assert.ok(!PATH_BEARING_CHECKS.has('response_schema'));
});

test('allowlist suppresses violations for documented exceptions', () => {
  const doc = {
    phases: [
      {
        id: 'p',
        steps: [
          {
            id: 'allowed',
            task: 'noop',
            response_schema_ref: 'media-buy/create-media-buy-response.json',
            validations: [{ check: 'field_present', path: 'definitely_not_real' }],
          },
        ],
      },
    ],
  };

  const allowlist = [
    {
      file: 'tests/synth/allowed.yaml',
      step: 'allowed',
      path: 'definitely_not_real',
      reason: 'synthesized for test',
    },
  ];

  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  const filePath = path.join(ROOT, 'tests', 'synth', 'allowed.yaml');

  const violations = lintDoc(doc, filePath, allowlist);
  assert.deepEqual(violations, []);
});

test('loadAllowlist enforces a reason field', () => {
  const allowlist = loadAllowlist();
  assert.ok(Array.isArray(allowlist), 'allowlist is an array');
  for (const entry of allowlist) {
    assert.ok(entry.reason, `every allowlist entry MUST carry a reason: ${JSON.stringify(entry)}`);
    assert.ok(entry.file && entry.step && entry.path, `entry MUST identify file/step/path: ${JSON.stringify(entry)}`);
  }
});
