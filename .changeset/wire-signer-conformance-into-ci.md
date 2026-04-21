---
---

Wire the signer-conformance harness (`tests/webhook-hmac-signer-conformance.test.cjs`, added by #2548) into the schema-validation CI workflow so the duplicate-key fixtures it exercises are enforced on every PR. Closes #2549. The fixtures asked for by #2546 were landed by #2548 — closing that too.

Also wires `test:hmac-vectors` (the verifier-side sibling) into the same step: it was present as an npm script but no CI workflow invoked it either. Both sides of the HMAC webhook conformance contract are now gated on every PR.

Adds a top-level harness assertion that `signer_side.rejection_vectors` and `signer_side.positive_vectors` exist and are non-empty, so a future fixture refactor can't silently make the gate vacuous.
