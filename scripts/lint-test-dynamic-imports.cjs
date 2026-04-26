#!/usr/bin/env node
/**
 * Fail if a vitest test file uses `await import('...project-source...')` inside
 * a `beforeEach`/`it`/`test` body, or calls `vi.resetModules()` in `beforeEach`.
 *
 * Why this exists: `vi.mock` is hoisted by vitest and applies to every
 * subsequent import of the mocked path, including dynamic ones. Sprinkling
 * `await import()` inside hot test loops re-resolves the entire transitive
 * module tree per test — under thread-pool contention this opens a race window
 * where another test's `mockResolvedValueOnce` queue gets consumed by a module
 * init path before the test's actual call reaches it (issue #3092 / #3118).
 * The static-import + `vi.hoisted` pattern is sufficient for ~all cases.
 *
 * Legitimate use of `vi.resetModules()` (e.g. testing module-load behavior
 * under different env-var states) can opt out with a trailing comment:
 *   vi.resetModules(); // lint-allow-resetmodules: testing env-var-loaded init
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');

// Treat any import whose specifier looks like a project source path as a
// project import. External libs (e.g. `await import('stripe')`) are fine —
// those are intentionally exercised, not modules-under-test.
const PROJECT_IMPORT = /await\s+import\s*\(\s*['"](\.\.\/[^'"]+|@\/[^'"]+|server\/[^'"]+)['"]/;
const RESET_MODULES = /vi\.resetModules\s*\(\s*\)/;
const ALLOW_RESET = /lint-allow-resetmodules/;
const ALLOW_DYNAMIC = /lint-allow-dynamic-import/;

function* walkTestFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTestFiles(full);
    } else if (entry.name.endsWith('.test.ts')) {
      yield full;
    }
  }
}

function scanFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const violations = [];
  const lines = source.split('\n');

  // File-level opt-out: a header comment that disables the lint for the whole
  // file. Useful when an entire file legitimately needs the patterns (e.g.
  // testing env-var-loaded module init).
  if (/lint-allow-test-imports-file/.test(source)) return [];

  lines.forEach((line, idx) => {
    if (PROJECT_IMPORT.test(line) && !ALLOW_DYNAMIC.test(line)) {
      violations.push({
        file: filePath,
        line: idx + 1,
        rule: 'no-dynamic-project-import',
        snippet: line.trim(),
      });
    }
    if (RESET_MODULES.test(line) && !ALLOW_RESET.test(line)) {
      violations.push({
        file: filePath,
        line: idx + 1,
        rule: 'no-reset-modules',
        snippet: line.trim(),
      });
    }
  });

  return violations;
}

function lint() {
  if (!fs.existsSync(TESTS_DIR)) return [];
  const all = [];
  for (const file of walkTestFiles(TESTS_DIR)) {
    all.push(...scanFile(file));
  }
  return all;
}

function formatViolation(v) {
  const rel = path.relative(ROOT, v.file);
  if (v.rule === 'no-reset-modules') {
    return `${rel}:${v.line}  vi.resetModules() — pattern is the wrong fix for stale-module-cache concerns. ` +
      `vi.mock is hoisted and applies to all subsequent imports. Use top-level static imports + ` +
      `vi.hoisted for shared mock refs. If you genuinely need module-cache reset (e.g. testing ` +
      `env-var-loaded module init), opt out with: vi.resetModules(); // lint-allow-resetmodules: <reason>`;
  }
  return `${rel}:${v.line}  await import('<project-source>') in test file — re-resolves ` +
    `the entire transitive module tree per call. Under thread-pool contention this opens a ` +
    `mock-queue race (issue #3092). Move to top-level static import. Opt out with: ` +
    `// lint-allow-dynamic-import: <reason>\n  ${v.snippet}`;
}

if (require.main === module) {
  const violations = lint();
  if (violations.length === 0) {
    console.log('lint-test-dynamic-imports: ok (no violations)');
    process.exit(0);
  }
  console.error(`lint-test-dynamic-imports: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(formatViolation(v) + '\n');
  process.exit(1);
}

module.exports = { lint, scanFile, PROJECT_IMPORT, RESET_MODULES };
