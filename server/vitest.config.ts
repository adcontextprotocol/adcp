import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: __dirname,
    setupFiles: ['./tests/setup/revenue-tracking-env.ts'],
    testTimeout: 30000,
    // Keep process isolation explicit so module-level singletons (database
    // pool, WorkOS client, env-cached secrets) cannot bleed between files.
    pool: 'forks',
    fileParallelism: false,
  },
});
