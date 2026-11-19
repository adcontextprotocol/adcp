import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// Workers share the @adcp/sdk validator cache with the storyboard matrix,
// except in CI (scripts/sdk-validator-cache.cjs).
const { validatorCacheEnv } = createRequire(import.meta.url)('./scripts/sdk-validator-cache.cjs') as {
  validatorCacheEnv(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string>;
};

export default defineConfig({
  test: {
    // Use threads pool instead of forks. The default fork pool hangs indefinitely
    // under non-TTY stdin (e.g. when invoked from a git pre-commit hook) because
    // server-side module init in imported code keeps child processes alive.
    // Threads share the parent process lifecycle and exit cleanly. Same speed.
    pool: 'threads',
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
