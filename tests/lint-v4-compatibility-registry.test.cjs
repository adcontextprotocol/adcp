#!/usr/bin/env node
/**
 * Tests for the AdCP 4.0 compatibility registry lint.
 *
 *   1. Source-tree guard: the real registry, storyboards, notice codes, and
 *      migration guide agree.
 *   2. Synthetic fixtures: each rule fires on the drift it exists to catch.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const { lint } = require('../scripts/lint-v4-compatibility-registry.cjs');

const GUIDE_REL = 'docs/reference/migration/v4-compatibility.mdx';

test('source tree passes the v4 compatibility registry lint', () => {
  const errors = lint();
  assert.deepEqual(errors, [], 'registry drift:\n  ' + errors.join('\n  '));
});

function validCheck(overrides = {}) {
  return {
    id: 'widget_ids_removed_in_4_0',
    issue: 1,
    change: 'removal',
    applies_to: ['sellers'],
    detection: 'A product declares widget_ids.',
    fix: 'Declare widgets instead.',
    observed_by: { validation: { storyboard: 'demo', steps: ['get_demo'] } },
    ...overrides,
  };
}

function validValidation(overrides = {}) {
  return {
    id: 'widget_ids_removed_in_4_0',
    check: 'all_fields_present',
    path: 'products[*].widgets',
    description: '[4.0 compatibility] Every product declares widgets',
    severity: 'advisory',
    permanent_advisory: { reason: 'AdCP 4.0 compatibility check.' },
    ...overrides,
  };
}

function makeFixture({
  checks = [validCheck()],
  validations = [validValidation()],
  canonicalCodes = {},
  anchors = ['widget_ids_removed_in_4_0'],
  notChecked,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-v4-compat-'));
  const sourceDir = path.join(root, 'source');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(sourceDir, 'universal'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, path.dirname(GUIDE_REL)), { recursive: true });

  fs.writeFileSync(
    path.join(sourceDir, 'universal/v4-compatibility.yaml'),
    yaml.dump({
      id: 'v4_compatibility',
      migration_guide: GUIDE_REL,
      checks,
      ...(notChecked && { schema_removals_not_checked: notChecked }),
    }),
  );
  fs.writeFileSync(
    path.join(sourceDir, 'universal/demo.yaml'),
    yaml.dump({
      id: 'demo',
      phases: [{ id: 'p', steps: [{ id: 'get_demo', task: 'get_products', validations }] }],
    }),
  );
  fs.writeFileSync(
    path.join(sourceDir, 'universal/runner-output-contract.yaml'),
    yaml.dump({ notice: { canonical_codes: canonicalCodes } }),
  );
  fs.writeFileSync(
    path.join(repoRoot, GUIDE_REL),
    anchors.map(a => `<a id="${a}"></a>\n### Heading\n`).join('\n'),
  );
  return { root, sourceDir, repoRoot };
}

function run(options = {}) {
  const fixture = makeFixture(options);
  const schemaDir = path.join(fixture.root, 'schemas');
  for (const [rel, doc] of Object.entries(options.schemas || {})) {
    fs.mkdirSync(path.dirname(path.join(schemaDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(schemaDir, rel), JSON.stringify(doc));
  }
  try {
    return lint({ sourceDir: fixture.sourceDir, repoRoot: fixture.repoRoot, schemaDir });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function assertRule(errors, rule) {
  assert.ok(
    errors.some(e => e.startsWith(`${rule}:`)),
    `expected a ${rule} error, got:\n  ${errors.join('\n  ') || '(none)'}`,
  );
}

test('a consistent fixture is clean', () => {
  assert.deepEqual(run(), []);
});

test('registry_shape: missing fix and bad change value', () => {
  assertRule(run({ checks: [validCheck({ fix: '', change: 'rename' })] }), 'registry_shape');
});

test('registry_shape: observed_by must name exactly one observation', () => {
  const checks = [validCheck({ observed_by: { validation: { storyboard: 'demo', steps: ['get_demo'] }, none: { reason: 'x' } } })];
  assertRule(run({ checks }), 'registry_shape');
});

test('duplicate_check_id', () => {
  assertRule(run({ checks: [validCheck(), validCheck()] }), 'duplicate_check_id');
});

test('unknown_storyboard and unknown_step', () => {
  assertRule(run({ checks: [validCheck({ observed_by: { validation: { storyboard: 'nope', steps: ['get_demo'] } } })] }), 'unknown_storyboard');
  assertRule(run({ checks: [validCheck({ observed_by: { validation: { storyboard: 'demo', steps: ['nope'] } } })] }), 'unknown_step');
});

test('validation_missing: the step has no validation with the check id', () => {
  assertRule(run({ validations: [validValidation({ id: 'something_else' })] }), 'validation_missing');
});

test('advisory_not_permanent: expires_after_version would promote on a 3.x run', () => {
  const validations = [validValidation({ permanent_advisory: undefined, expires_after_version: '99.0.0' })];
  assertRule(run({ validations }), 'advisory_not_permanent');
});

test('a required validation may observe a check', () => {
  const validations = [validValidation({ severity: undefined, permanent_advisory: undefined })];
  assert.deepEqual(run({ validations }), []);
});

test('unregistered_validation: a 4.0-shaped validation id outside the registry', () => {
  const validations = [validValidation(), validValidation({ id: 'gadget_required_in_4_0' })];
  assertRule(run({ validations }), 'unregistered_validation');
});

test('unknown_notice and unregistered_notice', () => {
  const noticeCheck = validCheck({
    id: 'thing_removed_in_4_0',
    observed_by: { notice: { storyboards: ['demo'] } },
  });
  assertRule(
    run({ checks: [validCheck(), noticeCheck], anchors: ['widget_ids_removed_in_4_0', 'thing_removed_in_4_0'] }),
    'unknown_notice',
  );
  assertRule(
    run({ canonicalCodes: { other_removed_in_4_0: { severity: 'deprecation', effective_version: '4.0' } } }),
    'unregistered_notice',
  );
});

test('a registered 4.0 notice code is clean', () => {
  const noticeCheck = validCheck({
    id: 'thing_removed_in_4_0',
    observed_by: { notice: { storyboards: ['demo'] } },
  });
  const errors = run({
    checks: [validCheck(), noticeCheck],
    canonicalCodes: { thing_removed_in_4_0: { severity: 'deprecation', effective_version: '4.0' } },
    anchors: ['widget_ids_removed_in_4_0', 'thing_removed_in_4_0'],
  });
  assert.deepEqual(errors, []);
});

test('a 4.0 notice code may be observed through a validation with the same id', () => {
  const errors = run({
    canonicalCodes: { widget_ids_removed_in_4_0: { severity: 'deprecation', effective_version: '4.0' } },
  });
  assert.deepEqual(errors, []);
});

test('validation_id_suffix: validation-observed ids end in _in_4_0', () => {
  const checks = [validCheck({ id: 'widget_ids_deprecated' })];
  const validations = [validValidation({ id: 'widget_ids_deprecated' })];
  assertRule(run({ checks, validations, anchors: ['widget_ids_deprecated'] }), 'validation_id_suffix');
});

test('migration_anchor_missing and stray_migration_anchor', () => {
  assertRule(run({ anchors: [] }), 'migration_anchor_missing');
  assertRule(run({ anchors: ['widget_ids_removed_in_4_0', 'ghost_removed_in_4_0'] }), 'stray_migration_anchor');
});

const WIDGET_SCHEMA = {
  'core/widget.json': {
    properties: {
      widget_ids: { type: 'array', deprecated: true, 'x-removed-in': '4.0.0' },
      gadget: { type: 'string', deprecated: true, 'x-removed-in': '4.0.0' },
    },
  },
};

test('schema sites listed in a check or as not checked are clean', () => {
  const checks = [validCheck({ schema_sites: ['core/widget.json#/properties/widget_ids'] })];
  const notChecked = [{ change: 'Gadget', issue: 2, reason: 'Buyer-sent.', sites: ['core/widget.json#/properties/gadget'] }];
  const errors = run({ checks, schemas: WIDGET_SCHEMA, notChecked });
  assert.deepEqual(errors, []);
});

test('schema_site_unlisted: a node marked for 4.0 removal is not in the registry', () => {
  const checks = [validCheck({ schema_sites: ['core/widget.json#/properties/widget_ids'] })];
  assertRule(run({ checks, schemas: WIDGET_SCHEMA, notChecked: [] }), 'schema_site_unlisted');
});

test('schema_site_invalid and schema_site_duplicate', () => {
  const checks = [validCheck({ schema_sites: ['core/widget.json#/properties/widget_ids', 'core/widget.json#/properties/nope'] })];
  const notChecked = [
    { change: 'Gadget', issue: 2, reason: 'Buyer-sent.', sites: ['core/widget.json#/properties/gadget', 'core/widget.json#/properties/widget_ids'] },
  ];
  const errors = run({ checks, schemas: WIDGET_SCHEMA, notChecked: notChecked });
  assertRule(errors, 'schema_site_invalid');
  assertRule(errors, 'schema_site_duplicate');
});

test('registry_shape: a not-checked group needs a reason and a tracking issue', () => {
  const checks = [validCheck({ schema_sites: ['core/widget.json#/properties/widget_ids'] })];
  const noReason = [{ change: 'Gadget', issue: 2, sites: ['core/widget.json#/properties/gadget'] }];
  assertRule(run({ checks, schemas: WIDGET_SCHEMA, notChecked: noReason }), 'registry_shape');
  const noIssue = [{ change: 'Gadget', reason: 'Buyer-sent.', sites: ['core/widget.json#/properties/gadget'] }];
  assertRule(run({ checks, schemas: WIDGET_SCHEMA, notChecked: noIssue }), 'registry_shape');
});
