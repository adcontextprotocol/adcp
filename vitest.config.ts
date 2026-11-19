import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// Workers share the @adcp/sdk validator cache with the storyboard matrix,
// except in CI (scripts/sdk-validator-cache.cjs).
const { validatorCacheEnv } = createRequire(import.meta.url)('./scripts/sdk-validator-cache.cjs') as {
  validatorCacheEnv(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string>;
};

export default defineConfig({
  test: {
    // Forks, not threads: with threads every worker's heap lives in the one
    // vitest process (5+ GB), and each child process a test spawns forks that
    // whole address space (57-70 ms of kernel time per spawn on Linux, against
    // 1.6 ms from a forks worker). A fork worker whose vitest main process dies
    // waits on it forever, so the launchers stop each command's whole process
    // group: the pre-commit runner (scripts/profile-precommit/runner.mjs) and
    // scripts/with-timeout.sh.
    pool: 'forks',
    // Cap individual test hangs at 10 s so a single stalled test doesn't
    // silently consume the entire 60 s precommit budget with no test name.
    testTimeout: 10000,
    // Builds dist/schemas/latest once, before any worker starts, for runs
    // that include a file that reads it (BUILT_SCHEMA_FILES there).
    globalSetup: ['./tests/setup/built-schemas.ts'],
    env: validatorCacheEnv(process.env, import.meta.dirname),
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.addie-repos/**',
      '**/*.test.cjs',
    ],
  },
});
