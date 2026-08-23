---
"adcontextprotocol": patch
---

Fix flaky server unit tests under full-suite parallelism.

- Pass `--config server/vitest.config.ts` to the individual-file
  precommit path so server tests always run with the forks pool
  instead of falling through to the root config's threads pool,
  where shared `process.env` causes env mutations in `vi.hoisted()`
  to bleed between concurrent workers.
- Explicitly declare `pool: 'forks'` in `server/vitest.config.ts`
  instead of relying on the implicit default.
- Route `tests/announcement/**` and `tests/billing/**` to the forks
  pool via `poolMatchGlobs` in the root vitest config — these
  directories set WORKOS/Stripe env vars in `vi.hoisted()` and must
  not share `process.env` with parallel thread workers.
- Add a root test setup file (`tests/setup/env-defaults.ts`) that
  pre-sets common WORKOS env defaults so individual test files no
  longer race to initialize them.

Refs #6740
