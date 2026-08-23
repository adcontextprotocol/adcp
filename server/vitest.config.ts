import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: __dirname,
    setupFiles: ['./tests/setup/revenue-tracking-env.ts'],
    testTimeout: 30000,
    // Forks give each test file its own process so module-level singletons
    // (db pool, WorkOS client, env-cached secrets) cannot bleed between files.
    // The root vitest config uses threads for speed; server tests need forks
    // because dozens of files set process.env in vi.hoisted() for route and
    // middleware init, and threads share process.env across all workers.
    pool: 'forks',
    fileParallelism: false,
  },
});
