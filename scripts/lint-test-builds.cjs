#!/usr/bin/env node
/**
 * Fail if a vitest test file builds dist/schemas/latest or
 * dist/compliance/latest itself: it names ensureBuilt, ensureBuiltSchemas or
 * ensureBuiltCompliance (a call, or an alias through destructuring), runs the
 * cache CLI (`scripts/built-schemas.cjs ensure`), or launches
 * scripts/build-schemas.cjs or scripts/build-compliance.cjs as a child.
 * Requiring a build script for one of its functions (buildTo) is fine.
 *
 * Why this exists: a build inside a test file runs inside a hook, a test or a
 * worker's import, under the file's timeout and next to every other worker. A
 * fresh checkout always has a stale tree, and a build lock left by a killed
 * holder makes the build wait first, so the file's setup takes minutes
 * (tp-jyw.46). A root-suite file that reads the built tree is listed in
 * BUILT_SCHEMA_FILES (tests/setup/built-schemas.ts), whose globalSetup builds
 * it once before any worker starts; server/vitest.config.ts does the same for
 * the server suite. node:test files (*.test.cjs) have no globalSetup and build at
 * module load, outside any test timeout, so this lint does not scan them.
 *
 * Opt out for one line with a comment on that line or the line above:
 *   // lint-allow-test-builds: <reason or ticket>
 * A file whose matches are fixtures (this lint's own tests) opts out with
 * `lint-allow-test-builds-file` in a comment.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEST_ROOTS = ['tests', 'server/tests', 'server/src'].map((dir) => path.join(ROOT, dir));
// vitest test files; *.test.cjs are node:test files.
const TEST_FILE = /\.test\.(?:ts|mts|cts|js|mjs)$/;

// Any reference to the ensure functions: a call, `const { ensureBuiltSchemas: ensure } = ...`, `cache.ensureBuilt(...)`.
const ENSURE_FUNCTION = /\bensureBuilt(?:Schemas|Compliance)?\b/g;
// The cache CLI: built-schemas.cjs followed by an `ensure` argument in the same command or argv.
const ENSURE_CLI = /built-schemas\.cjs['"`]?\s*,?\s*['"`]?ensure\b/g;
// A child process whose arguments name a build script.
const BUILD_LAUNCH = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\([^)]*?build-(?:schemas|compliance)\.cjs/g;
const ALLOW = /lint-allow-test-builds\b(?!-file)/;
const ALLOW_FILE = /lint-allow-test-builds-file/;

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
    ['no-ensure-built', ENSURE_FUNCTION],
    ['no-ensure-cli', ENSURE_CLI],
    ['no-build-launch', BUILD_LAUNCH],
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
  return `${path.relative(ROOT, v.file)}:${v.line}  [${v.rule}] a vitest test file builds dist/schemas or ` +
    `dist/compliance itself. List it in BUILT_SCHEMA_FILES (tests/setup/built-schemas.ts; the globalSetup ` +
    `builds once before any worker starts) or rely on server/vitest.config.ts's globalSetup. ` +
    `Opt out with: // lint-allow-test-builds: <reason>\n  ${v.snippet}`;
}

if (require.main === module) {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-test-builds: ok (no violations)');
    process.exit(0);
  }
  console.error(`lint-test-builds: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`${formatViolation(v)}\n`);
  process.exit(1);
}

module.exports = { lint, scanFile, scanSource };
