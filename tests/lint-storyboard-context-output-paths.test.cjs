#!/usr/bin/env node
/**
 * Tests for the storyboard context-output path lint (issue #3918, CI gate
 * item). Concerns:
 *   1. Source-tree guard — every real storyboard under
 *      static/compliance/source passes the lint. Regression guard.
 *   2. The `path_not_in_schema` rule fires for the canonical bug class —
 *      a context_outputs path that doesn't resolve to any defined field
 *      in the response schema (the offering_id / offering.offering_id typo
 *      that surfaced this lint).
 *   3. The path resolver follows the bracket / dot equivalence and descends
 *      through oneOf / anyOf variants and items.
 *   4. The allowlist mechanism suppresses entries for paths the lint can't
 *      statically verify (error.details polymorphism, additionalProperties
 *      runtime conventions).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  lintDoc,
  pathResolves,
  parsePath,
  loadSchema,
  loadAllowlist,
} = require('../scripts/lint-storyboard-context-output-paths.cjs');

test('source tree passes the context-output path lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have context_outputs path violations:\n' +
      violations
        .map((v) => `  ${v.filePath}:${v.stepId} — ${v.contextPath} (${v.rule})`)
        .join('\n'),
  );
});

test('path_not_in_schema fires for the canonical offering_id typo', () => {
  // Reproduce the bug this lint surfaced: si_get_offering captures
  // `offering_id` from si-get-offering-response.json, but the schema defines
  // `offering.offering_id` — top-level `offering_id` is undefined.
  const doc = {
    phases: [
      {
        id: 'discovery',
        steps: [
          {
            id: 'si_get_offering',
            task: 'si_get_offering',
            schema_ref: 'sponsored-intelligence/si-get-offering-request.json',
            response_schema_ref: 'sponsored-intelligence/si-get-offering-response.json',
            context_outputs: [{ name: 'offering_id', path: 'offering_id' }],
          },
        ],
      },
    ],
  };

  const violations = lintDoc(doc, '/synth/test.yaml');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'path_not_in_schema');
  assert.equal(violations[0].contextPath, 'offering_id');
  assert.equal(violations[0].captureName, 'offering_id');
});

test('path_not_in_schema does not fire when the path resolves through nested objects', () => {
  // Same storyboard with the corrected path — resolves through
  // properties.offering.properties.offering_id.
  const doc = {
    phases: [
      {
        id: 'discovery',
        steps: [
          {
            id: 'si_get_offering',
            task: 'si_get_offering',
            schema_ref: 'sponsored-intelligence/si-get-offering-request.json',
            response_schema_ref: 'sponsored-intelligence/si-get-offering-response.json',
            context_outputs: [{ name: 'offering_id', path: 'offering.offering_id' }],
          },
        ],
      },
    ],
  };

  const violations = lintDoc(doc, '/synth/test.yaml');
  assert.deepEqual(violations, []);
});

test('pathResolves descends oneOf variants — captures from a discriminated arm resolve', () => {
  // acquire-rights-response.json is a 4-arm oneOf. `rights_id` is on three
  // of the four arms (Acquired, PendingApproval, Rejected). The path
  // resolver should accept it because at least one variant defines it.
  const schema = loadSchema('brand/acquire-rights-response.json');
  assert.ok(schema, 'fixture schema loads');
  assert.equal(pathResolves(schema, parsePath('rights_id')), true);
  assert.equal(pathResolves(schema, parsePath('status')), true);
  assert.equal(pathResolves(schema, parsePath('reason')), true);
});

test('pathResolves rejects paths that no oneOf variant defines', () => {
  const schema = loadSchema('brand/acquire-rights-response.json');
  assert.equal(pathResolves(schema, parsePath('does_not_exist')), false);
  assert.equal(pathResolves(schema, parsePath('rights_id.subfield')), false);
});

test('pathResolves treats bracket and dotted notation as equivalent for array indexing', () => {
  const schema = loadSchema('brand/acquire-rights-response.json');
  // `errors[0].code` and `errors.0.code` both descend through items into
  // the error.json $ref's `code` property.
  assert.equal(pathResolves(schema, parsePath('errors[0].code')), true);
  assert.equal(pathResolves(schema, parsePath('errors.0.code')), true);
});

test('pure extension points (error.details, context.*) accept any further segments', () => {
  // sync-accounts-response defines accounts[].errors[] which $refs core/error.json,
  // whose `details` is `additionalProperties: true` with no defined properties —
  // a pure extension point because per-error-code structured details live in
  // sibling `error-details/<code>.json` schemas, not on `core/error.json` itself.
  const schema = loadSchema('account/sync-accounts-response.json');
  assert.equal(
    pathResolves(schema, parsePath('accounts[0].errors[0].details.suggested_billing')),
    true,
    'error.details.* should resolve via the pure-extension-point rule',
  );
});

test('mixed schemas (declared properties + additionalProperties: true) stay strict', () => {
  // si-get-offering-response.json has properties (offering, available, etc.)
  // AND additionalProperties: true at the root. The additionalProperties is
  // forward-compat extension, NOT an open container — the offering_id typo
  // from #3937 was caught precisely because the lint stays strict here.
  const schema = loadSchema('sponsored-intelligence/si-get-offering-response.json');
  assert.equal(pathResolves(schema, parsePath('offering.offering_id')), true);
  assert.equal(pathResolves(schema, parsePath('offering_id')), false);
  assert.equal(pathResolves(schema, parsePath('not_a_real_field')), false);
});

test('parsePath accepts both bracket and dotted forms', () => {
  assert.deepEqual(parsePath('rights[0].rights_id'), ['rights', '0', 'rights_id']);
  assert.deepEqual(parsePath('rights.0.rights_id'), ['rights', '0', 'rights_id']);
  assert.deepEqual(parsePath(''), []);
  assert.deepEqual(parsePath(null), []);
});

test('allowlist suppresses violations for documented exceptions', () => {
  const doc = {
    phases: [
      {
        id: 'p',
        steps: [
          {
            id: 'allowed_step',
            task: 'noop',
            response_schema_ref: 'sponsored-intelligence/si-get-offering-response.json',
            context_outputs: [{ name: 'x', path: 'definitely_not_real' }],
          },
        ],
      },
    ],
  };

  const allowlist = [
    {
      file: 'tests/synth/allowed.yaml',
      step: 'allowed_step',
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

test('loadAllowlist returns an array', () => {
  const allowlist = loadAllowlist();
  assert.ok(Array.isArray(allowlist), 'allowlist is an array');
  for (const entry of allowlist) {
    assert.ok(entry.reason, `every allowlist entry MUST carry a reason: ${JSON.stringify(entry)}`);
    assert.ok(entry.file && entry.step && entry.path, `entry MUST identify file/step/path: ${JSON.stringify(entry)}`);
  }
});
