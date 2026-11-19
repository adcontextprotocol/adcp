// Structural guard for the pre-commit hook path: the hook runs the leaves of
// `npm run precommit` through the concurrent runner, not through a nested
// `npm run` chain, and no hook leaf forces node:test to run its files one at
// a time. Both checks read what the hook will run: .husky/pre-commit and the
// runner's own plan (`node scripts/profile-precommit.mjs plan`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_LINE = 'exec node scripts/profile-precommit.mjs hook';

// Hook leaves allowed to run node:test files serially, with the reason.
// Empty: every hook-path node:test suite runs its files in parallel.
const SERIAL_NODE_TEST_ALLOWLIST: Record<string, string> = {};

/** Commands the hook runs by default (outside the opt-in profile branch). */
function defaultHookCommands(hookText: string): string[] {
  const commands: string[] = [];
  let depth = 0;
  for (const raw of hookText.split('\n')) {
    const line = raw.trim();
    if (/^if\b/.test(line)) { depth += 1; continue; }
    if (/^fi\b/.test(line)) { depth -= 1; continue; }
    if (depth > 0 || !line || line.startsWith('#') || /^(export|HUSKY_INIT=|\[)/.test(line)) continue;
    commands.push(line);
  }
  return commands;
}

function hookViolations(hookText: string): string[] {
  const commands = defaultHookCommands(hookText);
  const violations = commands.filter((c) => /\bnpm (run|exec)\b|\bnpx\b/.test(c)).map((c) => `nested npm launch: ${c}`);
  if (commands.at(-1) !== RUNNER_LINE) violations.push(`last command is not "${RUNNER_LINE}": ${commands.at(-1)}`);
  return violations;
}

const SERIAL_FLAG = /--test-concurrency(?:=|\s+)0*1(?=\s|$)/;

function serialLeaves(plan: Array<{ name: string; command: string }>): string[] {
  return plan.filter((c) => SERIAL_FLAG.test(c.command) && !(c.name in SERIAL_NODE_TEST_ALLOWLIST)).map((c) => c.name);
}

describe('pre-commit hook path guard', () => {
  it('runs the concurrent runner, not a nested npm run chain', () => {
    expect(hookViolations(readFileSync(join(REPO_ROOT, '.husky', 'pre-commit'), 'utf8'))).toEqual([]);
  });

  it('has no hook leaf that forces serial node:test files', () => {
    const plan = JSON.parse(execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'profile-precommit.mjs'), 'plan'], { cwd: REPO_ROOT, encoding: 'utf8' }));
    expect(plan.length).toBeGreaterThan(0);
    expect(serialLeaves(plan)).toEqual([]);
  });

  describe('meta: the checks catch what they ban', () => {
    const header = '#!/bin/sh\nexport PATH="node_modules/.bin:$PATH"\nif [ -n "${ADCP_PRECOMMIT_PROFILE-}" ]; then\n  exec node scripts/profile-precommit.mjs run --as-hook\nfi\n';

    it('flags the old sequential hook', () => {
      expect(hookViolations(`${header}bash scripts/check-image-quality.sh\nnpm run precommit\n`)).toHaveLength(2);
    });

    it('accepts the runner line', () => {
      expect(hookViolations(`${header}${RUNNER_LINE}\n`)).toEqual([]);
    });

    it('flags a serial node:test flag in both spellings and with a leading zero', () => {
      const leaf = (flag: string) => ({ name: 'x', command: `node --import tsx --test ${flag} --test-timeout=30000 a.test.cjs` });
      for (const flag of ['--test-concurrency=1', '--test-concurrency 1', '--test-concurrency=01']) {
        expect(serialLeaves([leaf(flag)]), flag).toEqual(['x']);
      }
    });

    it('accepts parallel node:test leaves', () => {
      const leaf = (flag: string) => ({ name: 'x', command: `node --test ${flag} a.test.cjs` });
      for (const flag of ['', '--test-concurrency=4', '--test-concurrency=10', '--test-timeout=1']) {
        expect(serialLeaves([leaf(flag)]), flag).toEqual([]);
      }
    });
  });
});
