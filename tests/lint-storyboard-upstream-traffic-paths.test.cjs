#!/usr/bin/env node
/**
 * Tests for the upstream_traffic identifier_paths portable grammar lint.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lint,
  RULE_MESSAGES,
  isPortableIdentifierPath,
} = require('../scripts/lint-storyboard-upstream-traffic-paths.cjs');

test('source tree passes the upstream_traffic path lint', () => {
  const violations = lint();
  assert.deepEqual(
    violations,
    [],
    'real storyboards have upstream_traffic identifier_paths violations:\n' +
      violations
        .map((v) => `  ${v.file} ${v.phase}/${v.step}[${v.index}] — ${v.identifier_path} (${v.rule})`)
        .join('\n'),
  );
});

function withTempStoryboardDir(name, doc, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-path-lint-'));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, doc);
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('portable identifier_paths are accepted', () => {
  const accepted = [
    'audiences[*].add[*].hashed_email',
    'line_items[*].creative-id',
    'user_1.identifiers[*]._sha256',
  ];
  for (const value of accepted) {
    assert.equal(isPortableIdentifierPath(value), true, value);
  }
});

test('non-portable identifier_paths are rejected', () => {
  const rejected = [
    '',
    '$.audiences[*].add[*].hashed_email',
    '$..hashed_email',
    'audiences[0].add[*].hashed_email',
    'audiences[*].add["hashed_email"]',
    'audiences..hashed_email',
    'request.audiences[*].hashed_email',
    'request[*].audiences[*].hashed_email',
    'response.audiences[*].hashed_email',
    'context.audiences[*].hashed_email',
    '0audiences[*].hashed_email',
  ];
  for (const value of rejected) {
    assert.equal(isPortableIdentifierPath(value), false, value);
  }
});

test('invalid identifier_path in storyboard is flagged', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            description: bad path
            min_count: 1
            identifier_paths:
              - "audiences[0].add[*].hashed_email"
`;
  withTempStoryboardDir('invalid.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'invalid_identifier_path');
    assert.equal(violations[0].identifier_path, 'audiences[0].add[*].hashed_email');
  });
});

test('non-array identifier_paths in storyboard is flagged', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            description: bad shape
            min_count: 1
            identifier_paths: "audiences[*].add[*].hashed_email"
`;
  withTempStoryboardDir('non-array.yaml', doc, (dir) => {
    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'invalid_identifier_path');
    assert.equal(violations[0].identifier_path, 'audiences[*].add[*].hashed_email');
  });
});

test('valid identifier_path in storyboard is accepted', () => {
  const doc = `
id: temp_storyboard
phases:
  - id: phase_a
    steps:
      - id: step_a
        task: get_products
        validations:
          - check: upstream_traffic
            description: good path
            min_count: 1
            identifier_paths:
              - "audiences[*].add[*].hashed_email"
`;
  withTempStoryboardDir('valid.yaml', doc, (dir) => {
    assert.deepEqual(lint(dir), []);
  });
});

test('every rule ID has a message', () => {
  const ruleIds = ['invalid_identifier_path'];
  for (const id of ruleIds) {
    assert.ok(typeof RULE_MESSAGES[id] === 'function', `missing message for rule ${id}`);
  }
});
