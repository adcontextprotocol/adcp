---
"adcontextprotocol": patch
---

Disable vitest `fileParallelism` for the server suite. The module-level `pool` singleton in `db/index.ts` is shared across tests in a worker — running files in parallel let one file's `afterAll(closeDatabase)` null the pool while a sibling was mid-query, producing "Database not initialized" 500s that looked like transient Anthropic flakes. Closes #3695.
