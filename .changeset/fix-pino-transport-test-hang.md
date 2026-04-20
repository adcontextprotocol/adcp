---
---

Fix the vitest teardown hang tracked in #2541.

`server/src/logger.ts` enabled the `pino-pretty` transport whenever `NODE_ENV !== 'production'`. Pino's transport spawns a worker thread and registers `process.on('exit', ...)` — the worker thread is a held handle that prevents Node's event loop from draining at test teardown, causing vitest workers to zombie indefinitely.

The logger now treats `NODE_ENV === 'test'` and the `VITEST=true` environment variable (auto-set by vitest) as non-development, so tests get the default synchronous stdout destination with no worker thread and no exit listener.

Validated: 6 back-to-back runs, 587 tests each, all clean exits, no `MaxListenersExceededWarning`.
