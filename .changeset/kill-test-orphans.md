---
---

Stop tests from leaking node processes.

- `tests/addie/cross-publisher-frequency-docs.test.ts` was spawning `node --import tsx --eval` child processes via `execFileSync` to query the docs indexer. The eval imports transitively opened a DB pool that kept the event loop alive forever, so each child orphaned (PPID=1) and accumulated — observed 45 instances running for up to 10 days. Replaced with direct vitest imports of `initializeDocsIndex`/`searchDocs`/`MODULE_RESOURCES`. Test now runs in ~1s inside the threads pool.
- `server/tests/integration/training-agent-webhooks.test.ts` only closed the receiver server in the success path. If the MCP request failed before the webhook arrived, the server leaked. Lifted `srv` to test scope and close it in `finally` with `closeAllConnections?.()` first.
- `server/tests/integration/training-agent-sse.test.ts` awaited `server.close()` without `closeAllConnections()`. SSE keeps long-lived connections; a test failure with an open `EventSource` hung `afterAll` until the test timeout. Added `closeAllConnections?.()` before close.
- `package.json` — added `--test-force-exit --test-timeout=30000` to the 16 chained `node --test` scripts so a future I/O-using test can't hang the whole `npm test` chain.
