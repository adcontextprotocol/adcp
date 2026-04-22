import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use threads pool instead of forks. The default fork pool hangs indefinitely
    // under non-TTY stdin (e.g. when invoked from a git pre-commit hook) because
    // server-side module init in imported code keeps child processes alive.
    // Threads share the parent process lifecycle and exit cleanly. Same speed.
    pool: 'threads',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.addie-repos/**',
      '**/*.test.cjs',
    ],
  },
});
