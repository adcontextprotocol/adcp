#!/usr/bin/env node
/**
 * Tests for `scripts/lint-test-spawn-tooling.cjs`.
 *
 *   1. Source-tree guard: no test file launches npx tsx/tsc or a tsc binary.
 *   2. Rule coverage: the launch forms the lint must catch, including the ones
 *      a single-line regex would miss, and the forms it must accept.
 *
 * The launch strings below are fixtures: lint-allow-test-spawn-tooling-file
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, scanFile, scanSource } = require('../scripts/lint-test-spawn-tooling.cjs');

const rules = (source) => scanSource(source).map((v) => v.rule);

test('source tree passes the lint', () => {
  const violations = lint();
  if (violations.length > 0) {
    const summary = violations.map((v) => `${path.relative(process.cwd(), v.file)}:${v.line}  [${v.rule}]`).join('\n');
    assert.fail(`Expected zero violations, got ${violations.length}:\n${summary}`);
  }
});

test('flags npx tsx and npx tsc launches', () => {
  assert.deepEqual(rules("execFileSync('npx', ['tsx', 'server/tests/manual/x.ts', '--validate-only']);"), ['no-npx-typescript-tool']);
  assert.deepEqual(rules("const r = spawnSync('npx', ['tsc', '--project', 'server/tsconfig.json'], { cwd });"), ['no-npx-typescript-tool']);
  assert.deepEqual(rules("execSync('npx tsc --noEmit');"), ['no-npx-typescript-tool']);
});

test('flags the forms a single-line pattern would miss', () => {
  // argv array on the next line, double quotes
  assert.deepEqual(rules(`const result = execFileSync("npx", [
      "tsx", "server/tests/manual/provider-router-eval.ts",
    ], { encoding: "utf8" });`), ['no-npx-typescript-tool']);
  // platform ternary for the executable, npx.cmd
  assert.deepEqual(rules(`const compiler = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsc", "--project", "server/tsconfig.json", "--noEmit"],
    );`), ['no-npx-typescript-tool']);
  // a tsc binary by path instead of npx
  assert.deepEqual(rules("spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'server']);"), ['no-tsc-binary']);
  assert.deepEqual(rules("execFileSync('node_modules/.bin/tsc', ['--noEmit']);"), ['no-tsc-binary']);
});

test('accepts this checkout tsx under process.execPath and non-launch mentions', () => {
  assert.deepEqual(rules("spawnSync(process.execPath, [tsx, 'server/tests/manual/x.ts', '--validate-only'], { env });"), []);
  assert.deepEqual(rules("spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script]);"), []);
  assert.deepEqual(rules("execFileSync('npx', ['vitest', 'list', '--json']);"), []);
  assert.deepEqual(rules("assert.deepEqual(normalizeWords(['npx', 'tsx', 'a.ts']), ['npx', 'tsx', 'a.ts']);"), []);
  assert.deepEqual(rules("expect(pkg.scripts.typecheck).toBe('tsc --project server/tsconfig.json --noEmit');"), []);
});

test('respects the opt-out comment on the launch line or the line above', () => {
  assert.deepEqual(rules(`// lint-allow-test-spawn-tooling: demonstrates the production compiler
    const compiler = spawnSync('npx', ['tsc', '--noEmit']);`), []);
  assert.deepEqual(rules("spawnSync('npx', ['tsc', '--noEmit']); // lint-allow-test-spawn-tooling: reason"), []);
});

test('scans files and honours the file-level opt-out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-tst-'));
  try {
    const flagged = path.join(dir, 'a.test.ts');
    fs.writeFileSync(flagged, "execFileSync('npx', ['tsx', 'x.ts']);\n");
    assert.deepEqual(scanFile(flagged).map((v) => [v.line, v.rule]), [[1, 'no-npx-typescript-tool']]);
    const optedOut = path.join(dir, 'b.test.ts');
    fs.writeFileSync(optedOut, "// lint-allow-test-spawn-tooling-file\nexecFileSync('npx', ['tsx', 'x.ts']);\n");
    assert.deepEqual(scanFile(optedOut), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
