---
---

Fix flaky announcement tests under `--pool=threads` by adding `vi.resetModules()` to `beforeEach` in all 7 affected test files, and add `testTimeout: 10000` to `vitest.config.ts` so individual hung tests fail with a name instead of silently consuming the 60s precommit budget.
