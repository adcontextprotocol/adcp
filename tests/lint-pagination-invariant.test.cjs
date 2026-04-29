#!/usr/bin/env node
/**
 * Tests for the pagination cursor↔has_more invariant lint.
 *
 *   1. Source-tree guard — schema examples and storyboards under
 *      static/{schemas,compliance}/source pass the lint today.
 *   2. Per-rule coverage — checkPagination fires on each violating shape
 *      and silently passes on every conformant shape (presence, absence,
 *      missing has_more).
 *   3. Walker contract — walkPaginationObjects descends into nested
 *      structures and returns dotted paths usable in violation reports.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  lintSchemas,
  lintStoryboards,
  checkPagination,
  walkPaginationObjects,
  RULE_MESSAGES,
} = require('../scripts/lint-pagination-invariant.cjs');

test('source tree passes the pagination-invariant lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real schemas/storyboards have pagination-invariant violations:\n' +
      violations.map((v) => `  ${v.file}:${v.location} — ${v.rule}`).join('\n'),
  );
});

test('checkPagination flags has_more=true without cursor', () => {
  const violation = checkPagination({ has_more: true });
  assert.ok(violation, 'expected violation for has_more=true with no cursor');
  assert.equal(violation.rule, 'has_more_true_missing_cursor');
});

test('checkPagination flags has_more=false with cursor present', () => {
  // Stale cursor on terminal page — the dishonest-pagination case.
  const violation = checkPagination({ has_more: false, cursor: 'opaque-token' });
  assert.ok(violation, 'expected violation for has_more=false with cursor');
  assert.equal(violation.rule, 'has_more_false_with_cursor');
});

test('checkPagination flags has_more=false with explicit null cursor', () => {
  // The spec calls for the field to be absent, not present-with-null. A `null`
  // cursor is still a present property and surfaces the same caller hazard
  // (downstream code reading pagination.cursor sees null vs. undefined).
  const violation = checkPagination({ has_more: false, cursor: null });
  assert.ok(violation);
  assert.equal(violation.rule, 'has_more_false_with_cursor');
});

test('checkPagination passes on conformant shapes', () => {
  // Every shape that the spec permits — page-with-cursor, terminal-no-cursor,
  // optional total_count alongside either — must not trip the lint.
  assert.equal(checkPagination({ has_more: true, cursor: 'next-page' }), null);
  assert.equal(checkPagination({ has_more: false }), null);
  assert.equal(
    checkPagination({ has_more: true, cursor: 'next-page', total_count: 42 }),
    null,
  );
  assert.equal(checkPagination({ has_more: false, total_count: 7 }), null);
});

test('checkPagination is a no-op when has_more is missing', () => {
  // Schema requires has_more, but the lint deliberately doesn't enforce
  // schema-level presence — that's response_schema's job. Without has_more
  // the cursor invariant has no anchor.
  assert.equal(checkPagination({}), null);
  assert.equal(checkPagination({ cursor: 'orphan' }), null);
});

test('walkPaginationObjects descends into nested structures and reports dotted paths', () => {
  const root = {
    accounts: [{ id: 'a' }, { id: 'b' }],
    pagination: { has_more: true, cursor: 'tok' },
    nested: {
      query_summary: {
        pagination: { has_more: false },
      },
    },
  };
  const found = [...walkPaginationObjects(root)].map((entry) => entry.pathSoFar.join('.'));
  // Two pagination objects: top-level, and nested under query_summary. Order
  // is iteration order of Object.entries (preserved for non-integer keys).
  assert.deepEqual(found, ['pagination', 'nested.query_summary.pagination']);
});

test('walkPaginationObjects skips pagination-shaped values without a boolean has_more', () => {
  // The shape filter intentionally requires `typeof has_more === 'boolean'`
  // so storyboards/schemas that happen to use the field name `pagination`
  // for unrelated purposes don't surface false positives.
  const noisy = {
    pagination: 'something else entirely',
    other: { pagination: { has_more: 'not a bool' } },
    arr: [{ pagination: null }],
  };
  assert.equal([...walkPaginationObjects(noisy)].length, 0);
});

test('lintSchemas catches violations in synthetic schema examples', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-lint-schema-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'list-things-response.json'),
      JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'List Things Response',
        examples: [
          {
            description: 'Mid-page (continuable) but missing cursor',
            data: { things: [], pagination: { has_more: true } },
          },
          {
            description: 'Terminal page with stale cursor',
            data: { things: [], pagination: { has_more: false, cursor: 'stale' } },
          },
          {
            description: 'Conformant — terminal with total_count',
            data: { things: [], pagination: { has_more: false, total_count: 0 } },
          },
        ],
      }),
    );
    const violations = lintSchemas(tmp);
    assert.equal(violations.length, 2, JSON.stringify(violations, null, 2));
    assert.equal(violations[0].rule, 'has_more_true_missing_cursor');
    assert.match(violations[0].location, /examples\[0\]\.pagination/);
    assert.equal(violations[1].rule, 'has_more_false_with_cursor');
    assert.match(violations[1].location, /examples\[1\]\.pagination/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lintSchemas handles unwrapped examples (payload at array element top level)', () => {
  // Some schemas put the payload directly at examples[i]; others wrap it
  // in `{ description, data }`. The lint must accept both shapes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-lint-unwrapped-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'unwrapped.json'),
      JSON.stringify({
        examples: [
          { items: [], pagination: { has_more: true } },
        ],
      }),
    );
    const violations = lintSchemas(tmp);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'has_more_true_missing_cursor');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lintStoryboards catches violations in synthetic sample_request and sample_response', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-lint-sb-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'sb.yaml'),
      `
id: sb_pagination
phases:
  - id: list_phase
    steps:
      - id: bad_response
        task: list_creatives
        sample_response:
          creatives: []
          pagination:
            has_more: false
            cursor: "stale-token"
      - id: bad_request
        task: list_creatives
        sample_request:
          pagination:
            has_more: true
      - id: clean
        task: list_creatives
        sample_response:
          pagination:
            has_more: true
            cursor: "next-page"
`,
    );
    const violations = lintStoryboards(tmp);
    assert.equal(violations.length, 2, JSON.stringify(violations, null, 2));
    assert.equal(violations[0].rule, 'has_more_false_with_cursor');
    assert.match(violations[0].location, /steps\.bad_response\.sample_response\.pagination/);
    assert.equal(violations[1].rule, 'has_more_true_missing_cursor');
    assert.match(violations[1].location, /steps\.bad_request\.sample_request\.pagination/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lintSchemas silently skips malformed JSON', () => {
  // Defensive: a corrupt schema file shouldn't take down the lint. The
  // try/catch at lint-pagination-invariant.cjs surfaces zero violations
  // for the unparseable file and continues with the rest of the tree.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-lint-malformed-json-'));
  try {
    fs.writeFileSync(path.join(tmp, 'broken.json'), '{ this is not json');
    fs.writeFileSync(
      path.join(tmp, 'good.json'),
      JSON.stringify({
        examples: [{ data: { pagination: { has_more: true } } }],
      }),
    );
    const violations = lintSchemas(tmp);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'has_more_true_missing_cursor');
    assert.match(violations[0].file, /good\.json$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lintStoryboards silently skips malformed YAML and storyboards without phases', () => {
  // Two distinct guards in lintStoryboards: the yaml.load try/catch and the
  // Array.isArray(doc.phases) check. Exercise both.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-lint-malformed-yaml-'));
  try {
    fs.writeFileSync(path.join(tmp, 'broken.yaml'), 'id: bad\nphases:\n  - this is: : invalid');
    fs.writeFileSync(path.join(tmp, 'no-phases.yaml'), 'id: schema_helper\ntitle: not a storyboard\n');
    fs.writeFileSync(
      path.join(tmp, 'good.yaml'),
      `
id: sb_good
phases:
  - id: p
    steps:
      - id: s
        task: list_creatives
        sample_response:
          pagination:
            has_more: true
`,
    );
    const violations = lintStoryboards(tmp);
    assert.equal(violations.length, 1, JSON.stringify(violations, null, 2));
    assert.equal(violations[0].rule, 'has_more_true_missing_cursor');
    assert.match(violations[0].file, /good\.yaml$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lintStoryboards renders <unnamed> for missing phase.id and step.id', () => {
  // Authoring-UX: the location string falls back to `<unnamed>` when an
  // author drafts a storyboard without ids. The rendering must be stable
  // so error output is grep-able.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-lint-unnamed-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'draft.yaml'),
      `
id: sb_draft
phases:
  - steps:
      - task: list_creatives
        sample_response:
          pagination:
            has_more: false
            cursor: "leftover"
`,
    );
    const violations = lintStoryboards(tmp);
    assert.equal(violations.length, 1);
    assert.match(violations[0].location, /phases\.<unnamed>\.steps\.<unnamed>\./);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('walkPaginationObjects survives self-referential cycles', () => {
  // YAML anchors can resolve to ancestor references (`&a … *a`). js-yaml
  // does not reject the construct, so the walker MUST guard against it
  // or we stack-overflow on a pathological storyboard.
  const root = { name: 'root', pagination: { has_more: true, cursor: 'tok' } };
  root.self = root;
  const found = [...walkPaginationObjects(root)];
  assert.equal(found.length, 1, 'visited guard should yield exactly once on a cycle');
  assert.deepEqual(found[0].pathSoFar, ['pagination']);
});

test('RULE_MESSAGES point authors at the canonical schema', () => {
  // Authoring-UX anchor: when this lint fires, the message MUST tell the
  // author where the contract lives. If the link rots, this test localizes
  // the regression instead of the author chasing it through the codebase.
  for (const rule of Object.keys(RULE_MESSAGES)) {
    const msg = RULE_MESSAGES[rule]();
    assert.match(msg, /pagination-response\.json/, `${rule} message must reference the schema`);
  }
});
