import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: __dirname,
    setupFiles: ['./tests/setup/revenue-tracking-env.ts'],
    testTimeout: 30000,
    // The module-level `pool` singleton in db/index.ts is shared across all
    // tests in a worker. Running files in parallel lets one file's
    // `afterAll(closeDatabase)` null the pool while a sibling file is
    // mid-query, producing "Database not initialized" 500s that look like
    // transient Anthropic flakes.
    fileParallelism: false,
  },
});
