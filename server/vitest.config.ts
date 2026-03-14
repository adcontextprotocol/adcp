import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: __dirname,
    setupFiles: ['./tests/setup/revenue-tracking-env.ts'],
    testTimeout: 30000,
  },
});
