---
---

Wire the signer-conformance harness (`tests/webhook-hmac-signer-conformance.test.cjs`, added by #2548) into `npm test` so the duplicate-key fixtures it exercises are enforced on every CI run. Closes #2549. The fixtures asked for by #2546 were landed by #2548 — closing that too.

Without this wiring the harness and fixtures existed but weren't on the default test path, so a regression in the reference signer (or a fixture miscategorization) would not have failed CI.
