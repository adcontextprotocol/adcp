// Fixture for tests/built-schemas-setup.test.ts (named so it is not one of
// the repository's vitest suite configs): a globalSetup that records
// the run's test files as vitest's state holds them when global setups start.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite's cache goes under the repository's ignored node_modules, not here.
  cacheDir: '../../../node_modules/.vite/global-setup-paths',
  test: {
    include: ['*.fixture.ts'],
    pool: 'threads',
    globalSetup: ['./record-paths.ts'],
  },
});
