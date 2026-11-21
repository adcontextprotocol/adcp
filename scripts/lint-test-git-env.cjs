#!/usr/bin/env node
/**
 * Fail if a test file runs real git without the shared fixture environment
 * from tests/helpers/git-object-fixture.cjs.
 *
 * Why this exists: inside a linked-worktree git hook, git exports
 * GIT_DIR=<repo>/.git/worktrees/<name> and GIT_INDEX_FILE to the hook, and a
 * test it runs inherits them. Fixture git that keeps them commits, tags and
 * fetches into the caller's repository, and `git init` writes core.bare=true
 * into its shared config, which breaks every worktree. The caller's global
 * config (hooks paths, signing) also runs on every fixture call.
 *
 * A test file that launches git passes when either
 *   - it calls isolateGitEnv(...) (process-level, covers the steps and
 *     scripts it spawns from process.env too), or
 *   - every git launch passes env: fixtureEnv(...),
 * or a launch that reads the enclosing checkout on purpose carries, on its
 * line or the line above:
 *   // lint-allow-caller-git: <reason>
 *
 * tests/git-env-isolation.test.cjs runs every file this lint finds under a
 * real linked-worktree hook environment and checks the caller is untouched.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEST_ROOTS = ['tests', 'server/tests'];
const TEST_FILE = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;

// A child-process launch whose executable is the literal 'git' or a variable
// named for it (git, gitBin, realGit, REAL_GIT; not digits or legitTool), or
// a command string that starts with `git `.
const LAUNCH = String.raw`\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*(?:['"\x60]git['"\x60]|(?:git[\w$]*|[\w$]*Git[\w$]*|[\w$]*GIT[\w$]*)\b)|\b(?:execSync|exec)\s*\(\s*['"\x60]git\s`;
const GIT_LAUNCH_ONE = new RegExp(LAUNCH);
const GIT_LAUNCH_ALL = new RegExp(LAUNCH, 'g');
// Files that reach git only through the shared helper (gitFixture, gitIn).
const USES_HELPER = /git-object-fixture/;
const PROCESS_ISOLATION = /\bisolateGitEnv\s*\(/;
const FIXTURE_ENV = /\benv\s*:\s*fixtureEnv\s*\(/;
const ALLOW = /lint-allow-caller-git\s*:/;
const CALL_WINDOW = 800;

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEST_FILE.test(entry.name)) yield full;
  }
}

/** Repository-relative paths of test files that run git, sorted. */
function gitTestFiles() {
  const files = [];
  for (const root of TEST_ROOTS) {
    for (const file of walk(path.join(ROOT, root))) {
      const source = fs.readFileSync(file, 'utf8');
      if (GIT_LAUNCH_ONE.test(source) || USES_HELPER.test(source)) files.push(path.relative(ROOT, file));
    }
  }
  return files.sort();
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** The launch call's text: from the match to its closing parenthesis (or a bounded window). */
function callText(source, start) {
  let depth = 0;
  const end = Math.min(source.length, start + CALL_WINDOW);
  for (let i = source.indexOf('(', start); i >= 0 && i < end; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start, end);
}

function scanSource(source, file = '<source>') {
  if (PROCESS_ISOLATION.test(source)) return [];
  const lines = source.split('\n');
  const violations = [];
  GIT_LAUNCH_ALL.lastIndex = 0;
  for (const match of source.matchAll(GIT_LAUNCH_ALL)) {
    const line = lineOf(source, match.index);
    if (ALLOW.test(lines[line - 1] ?? '') || ALLOW.test(lines[line - 2] ?? '')) continue;
    if (FIXTURE_ENV.test(callText(source, match.index))) continue;
    violations.push({ file, line, rule: 'test-git-without-fixture-env', snippet: match[0].replace(/\s+/g, ' ') });
  }
  return violations;
}

function scanFile(filePath) {
  return scanSource(fs.readFileSync(filePath, 'utf8'), filePath);
}

function lint() {
  return gitTestFiles().flatMap((file) => scanFile(path.join(ROOT, file)));
}

function formatViolation(v) {
  return `${path.relative(ROOT, v.file)}:${v.line}  [${v.rule}] a test runs git with the caller's environment. ` +
    `Inside a worktree hook it inherits GIT_DIR/GIT_INDEX_FILE and writes to the caller's repository. ` +
    `Call isolateGitEnv() from tests/helpers/git-object-fixture.cjs at module scope, or pass ` +
    `env: fixtureEnv() on the launch. A read of the enclosing checkout opts out with: ` +
    `// lint-allow-caller-git: <reason>\n  ${v.snippet}`;
}

if (require.main === module) {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-test-git-env: ok (no violations)');
    process.exit(0);
  }
  console.error(`lint-test-git-env: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`${formatViolation(v)}\n`);
  process.exit(1);
}

module.exports = { gitTestFiles, lint, scanFile, scanSource };
