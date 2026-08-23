import { defineConfig } from 'vitest/config';

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
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.addie-repos/**',
      '**/*.test.cjs',
    ],
  },
});
