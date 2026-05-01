#!/usr/bin/env node
/**
 * Tests for `scripts/lint-callapi-state-change.cjs`.
 *
 *   1. Source-tree guard — the current Addie MCP tree passes the lint,
 *      so a regression that reintroduces `callApi('POST'|...)` surfaces
 *      immediately in CI.
 *   2. Per-rule coverage — `scanFile` flags POST/PUT/DELETE/PATCH and
 *      accepts GET.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, scanFile } = require('../scripts/lint-callapi-state-change.cjs');

function withTempFile(name, contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-callapi-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('source tree passes the lint', () => {
  const violations = lint();
  if (violations.length > 0) {
    const summary = violations
      .map((v) => `${path.relative(process.cwd(), v.file)}:${v.line}  callApi('${v.method}', …)`)
      .join('\n');
    assert.fail(`Expected zero violations, got ${violations.length}:\n${summary}`);
  }
});

test('flags POST loopback', () => {
  withTempFile('x.ts', `await callApi('POST', '/api/x', ctx);`, (file) => {
    const v = scanFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].method, 'POST');
  });
});

test('flags PUT loopback', () => {
  withTempFile('x.ts', `await callApi('PUT', '/api/x', ctx);`, (file) => {
    const v = scanFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].method, 'PUT');
  });
});

test('flags DELETE loopback', () => {
  withTempFile('x.ts', `await callApi('DELETE', '/api/x', ctx);`, (file) => {
    const v = scanFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].method, 'DELETE');
  });
});

test('flags PATCH loopback', () => {
  withTempFile('x.ts', `await callApi('PATCH', '/api/x', ctx);`, (file) => {
    const v = scanFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].method, 'PATCH');
  });
});

test('accepts GET (the only legal shape)', () => {
  withTempFile('x.ts', `await callApi('GET', '/api/x', ctx);`, (file) => {
    assert.deepEqual(scanFile(file), []);
  });
});

test('accepts double-quoted method literals (matches loose source style)', () => {
  withTempFile('x.ts', `await callApi("POST", '/api/x', ctx);`, (file) => {
    const v = scanFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].method, 'POST');
  });
});

test('catches multi-line callApi shapes (the form removed in PR #3741)', () => {
  withTempFile(
    'x.ts',
    [
      'await callApi(',
      "  'POST',",
      "  '/api/x',",
      '  ctx,',
      ');',
    ].join('\n'),
    (file) => {
      const v = scanFile(file);
      assert.equal(v.length, 1);
      assert.equal(v[0].method, 'POST');
      // Line number should point at `callApi(` (line 1), not the
      // method literal on the continuation line.
      assert.equal(v[0].line, 1);
    },
  );
});

test('does not false-positive on line comments referencing the bug class', () => {
  withTempFile(
    'x.ts',
    [
      "// historical note: callApi('POST', …) used to silently 403",
      "await callApi('GET', '/api/x', ctx);",
    ].join('\n'),
    (file) => {
      assert.deepEqual(scanFile(file), []);
    },
  );
});

test('does not false-positive on block comments', () => {
  withTempFile(
    'x.ts',
    [
      '/**',
      " * Issue #3736 fixed by removing callApi('PUT', …) loopbacks.",
      " * Migrated callApi('DELETE', …) to direct service calls.",
      ' */',
      "await callApi('GET', '/api/x', ctx);",
    ].join('\n'),
    (file) => {
      assert.deepEqual(scanFile(file), []);
    },
  );
});
