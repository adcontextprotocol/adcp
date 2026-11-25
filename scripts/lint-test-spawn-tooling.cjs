#!/usr/bin/env node
/**
 * Fail if a test file launches the TypeScript tool chain as a child process:
 * `npx tsx` / `npx tsc` (any quoting, `npx.cmd`, a ternary first argument,
 * the argv array on a later line, or an `exec('npx tsc ...')` command string),
 * or a `tsc` binary by path (`node_modules/.bin/tsc`, `typescript/bin/tsc`).
 *
 * Why this exists: a cold `npx` + TypeScript child costs a second or more per
 * launch and its start-up time grows with machine load, so suites that spawn
 * them dominate local test time and fail on short timeouts. A type check
 * belongs to the typecheck step, not inside a unit test. When a test needs a
 * TypeScript entrypoint in a fresh process, run it with
 * `process.execPath` and this checkout's tsx (`--import tsx`, or the realpath
 * of node_modules/.bin/tsx); when it needs emitted JavaScript, transpile the
 * module closure in-process with the TypeScript API.
 *
 * Opt out for one launch with a comment on the launch line or the line above:
 *   // lint-allow-test-spawn-tooling: <reason or ticket>
 * A file whose launch strings are fixtures (this lint's own tests) opts out
 * with `lint-allow-test-spawn-tooling-file` in a comment.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEST_ROOTS = ['tests', 'server/tests'].map((dir) => path.join(ROOT, dir));
const TEST_FILE = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;

// A launch call, then (lazily, across lines) a quoted `npx` or `npx.cmd`
// inside the first argument, then the argv array whose first entry is tsx/tsc.
const NPX_TOOL_ARGV = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(\s*[^,]*?['"`]npx(?:\.cmd)?['"`][^,]*,\s*\[\s*['"`](tsx|tsc)['"`]/g;
// exec/execSync with a command string that starts with `npx tsx|tsc`.
const NPX_TOOL_COMMAND = /\b(?:exec|execSync)\s*\(\s*['"`]\s*npx\s+(tsx|tsc)\b/g;
// A launch whose arguments name a tsc binary by path.
const TSC_BY_PATH = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\([^)]*?['"`][^'"`]*(?:\.bin\/tsc|typescript\/bin\/tsc)\b[^'"`]*['"`]/g;
const ALLOW = /lint-allow-test-spawn-tooling/;
const ALLOW_FILE = /lint-allow-test-spawn-tooling-file/;

function* walkTestFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTestFiles(full);
    else if (TEST_FILE.test(entry.name)) yield full;
  }
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function allowed(lines, line) {
  return ALLOW.test(lines[line - 1] ?? '') || ALLOW.test(lines[line - 2] ?? '');
}

function scanSource(source, file = '<source>') {
  const lines = source.split('\n');
  const violations = [];
  const rules = [
    ['no-npx-typescript-tool', NPX_TOOL_ARGV],
    ['no-npx-typescript-tool', NPX_TOOL_COMMAND],
    ['no-tsc-binary', TSC_BY_PATH],
  ];
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = lineOf(source, match.index);
      if (allowed(lines, line)) continue;
      violations.push({ file, line, rule, snippet: match[0].replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return violations;
}

function scanFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (ALLOW_FILE.test(source)) return [];
  return scanSource(source, filePath);
}

function lint() {
  const all = [];
  for (const root of TEST_ROOTS) for (const file of walkTestFiles(root)) all.push(...scanFile(file));
  return all;
}

function formatViolation(v) {
  return `${path.relative(ROOT, v.file)}:${v.line}  [${v.rule}] a test launches the TypeScript tool chain as a ` +
    `child process. Run TypeScript entrypoints with process.execPath and this checkout's tsx, transpile ` +
    `emitted JavaScript in-process with the TypeScript API, and leave type checks to the typecheck step. ` +
    `Opt out with: // lint-allow-test-spawn-tooling: <reason>\n  ${v.snippet}`;
}

if (require.main === module) {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-test-spawn-tooling: ok (no violations)');
    process.exit(0);
  }
  console.error(`lint-test-spawn-tooling: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`${formatViolation(v)}\n`);
  process.exit(1);
}

module.exports = { lint, scanFile, scanSource };
