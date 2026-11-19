#!/usr/bin/env node
/**
 * Tests for `scripts/lint-test-builds.cjs`.
 *
 *   1. Source-tree guard: no vitest test file builds dist/schemas or
 *      dist/compliance itself.
 *   2. Rule coverage: the forms the lint must catch, including an aliased
 *      ensure function a call-only pattern would miss, and the forms it must
 *      accept.
 *
 * The build calls below are fixtures: lint-allow-test-builds-file
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, scanFile, scanSource } = require('../scripts/lint-test-builds.cjs');

const rules = (source) => scanSource(source).map((v) => v.rule);

test('source tree passes the lint', () => {
  const violations = lint();
  if (violations.length > 0) {
    const summary = violations.map((v) => `${path.relative(process.cwd(), v.file)}:${v.line}  [${v.rule}]`).join('\n');
    assert.fail(`Expected zero violations, got ${violations.length}:\n${summary}`);
  }
});

test('flags an ensure call in a hook, a test body or at module level', () => {
  assert.deepEqual(rules('beforeAll(() => {\n  ensureBuiltSchemas();\n}, 180_000);'), ['no-ensure-built']);
  assert.deepEqual(rules("it('x', () => { ensureBuiltCompliance(); });"), ['no-ensure-built']);
  assert.deepEqual(rules("require('../scripts/built-schemas.cjs').ensureBuilt('schemas');"), ['no-ensure-built']);
});

test('flags the forms a call-only pattern would miss', () => {
  // An alias through destructuring, then a call under another name.
  assert.deepEqual(rules("const { ensureBuiltSchemas: ensure } = require('../scripts/built-schemas.cjs');\nensure();"),
    ['no-ensure-built']);
  // The cache CLI, as a command string and as an argv array.
  assert.deepEqual(rules("execSync('node scripts/built-schemas.cjs ensure schemas');"), ['no-ensure-cli']);
  assert.deepEqual(rules("spawnSync(process.execPath, ['scripts/built-schemas.cjs', 'ensure', 'compliance']);"),
    ['no-ensure-cli']);
  // A build script launched as a child.
  assert.deepEqual(rules("spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-schemas.cjs')]);"), ['no-build-launch']);
  assert.deepEqual(rules('execFileSync(process.execPath, ["scripts/build-compliance.cjs"], { cwd });'), ['no-build-launch']);
});

test('accepts reading the built tree and requiring a build script for a function', () => {
  assert.deepEqual(rules("const { BUILT_DIR } = require('../../scripts/built-schemas.cjs');"), []);
  assert.deepEqual(rules("const { buildTo } = require('../../scripts/build-compliance.cjs');"), []);
  assert.deepEqual(rules("spawnSync(process.execPath, ['scripts/built-schemas.cjs', 'status', 'schemas']);"), []);
  assert.deepEqual(rules("const stale = buildStatus('schemas').fresh === false;"), []);
});

test('respects the opt-out comment on the line or the line above', () => {
  assert.deepEqual(rules('// lint-allow-test-builds: measures the build itself\nensureBuiltSchemas();'), []);
  assert.deepEqual(rules('ensureBuiltSchemas(); // lint-allow-test-builds: reason'), []);
});

test('scans vitest files, skips node:test files and honours the file-level opt-out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-test-builds-'));
  try {
    const flagged = path.join(dir, 'a.test.ts');
    fs.writeFileSync(flagged, 'import x from "y";\nensureBuiltSchemas();\n');
    assert.deepEqual(scanFile(flagged).map((v) => [v.line, v.rule]), [[2, 'no-ensure-built']]);
    const optedOut = path.join(dir, 'b.test.ts');
    fs.writeFileSync(optedOut, '// lint-allow-test-builds-file\nensureBuiltSchemas();\n');
    assert.deepEqual(scanFile(optedOut), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
