#!/usr/bin/env node
/**
 * Tests for `scripts/lint-test-dynamic-imports.cjs`.
 *
 *   1. Source-tree guard — the current test tree passes the lint, so a
 *      regression in test-file structure surfaces immediately.
 *   2. Per-rule coverage — `scanFile` flags resetModules + dynamic project
 *      imports, accepts external-lib dynamic imports, and respects the
 *      line-level + file-level opt-out comments.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, scanFile } = require('../scripts/lint-test-dynamic-imports.cjs');

function withTempFile(name, contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-tdi-'));
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
    const summary = violations.map((v) => `${path.relative(process.cwd(), v.file)}:${v.line}  [${v.rule}]`).join('\n');
    assert.fail(`Expected zero violations, got ${violations.length}:\n${summary}`);
  }
});

test('flags vi.resetModules() in a test file', () => {
  withTempFile('a.test.ts', `
    import { vi, beforeEach } from 'vitest';
    beforeEach(() => { vi.resetModules(); });
  `, (file) => {
    const v = scanFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'no-reset-modules');
  });
});

test('respects line-level opt-out for resetModules', () => {
  withTempFile('a.test.ts', `
    import { vi, beforeEach } from 'vitest';
    beforeEach(() => { vi.resetModules(); /* lint-allow-resetmodules: env-loaded init */ });
  `, (file) => {
    assert.deepEqual(scanFile(file), []);
  });
});

test('flags dynamic import of a relative project path', () => {
  withTempFile('a.test.ts', `
    import { test } from 'vitest';
    test('x', async () => {
      const { foo } = await import('../../server/src/foo.js');
    });
  `, (file) => {
    const v = scanFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'no-dynamic-project-import');
  });
});

test('does NOT flag dynamic import of an external lib', () => {
  withTempFile('a.test.ts', `
    import { test } from 'vitest';
    test('x', async () => {
      const Stripe = (await import('stripe')).default;
    });
  `, (file) => {
    assert.deepEqual(scanFile(file), []);
  });
});

test('respects line-level opt-out for dynamic project import', () => {
  withTempFile('a.test.ts', `
    import { test } from 'vitest';
    test('x', async () => {
      const { foo } = await import('../../server/src/foo.js'); // lint-allow-dynamic-import: legacy
    });
  `, (file) => {
    assert.deepEqual(scanFile(file), []);
  });
});

test('respects file-level opt-out comment', () => {
  withTempFile('a.test.ts', `
    // lint-allow-test-imports-file: legitimate env-loaded module init test
    import { vi, beforeEach, test } from 'vitest';
    beforeEach(() => { vi.resetModules(); });
    test('x', async () => {
      const { foo } = await import('../../server/src/foo.js');
    });
  `, (file) => {
    assert.deepEqual(scanFile(file), []);
  });
});
