// The typecheck step of the pre-commit hook: package.json's `typecheck`
// script, expanded into its leaf commands as the hook's plan expands scripts
// (scripts/profile-precommit/plan.mjs), run concurrently as the hook ran
// them. tsc is a native binary, so this is the one place a test launches it:
// it is the typecheck step itself, not a unit test that type-checks
// (lint-allow-test-spawn-tooling-file).
import { describe, expect, test } from 'vitest';
import { planCommands } from '../../scripts/profile-precommit/plan.mjs';
import { failureMessage, REPO_ROOT, runHookCommand } from './command';

const leaves = planCommands({ root: REPO_ROOT, roots: [{ line: 'npm run typecheck' }] }).commands.map((c) => c.command);

describe('npm run typecheck', () => {
  test('expands to at least one command', () => {
    expect(leaves.length).toBeGreaterThan(0);
  });

  for (const command of leaves) {
    test.concurrent(command, async () => {
      const result = await runHookCommand(command);
      expect(result.status, failureMessage(command, result)).toBe(0);
    });
  }
});
