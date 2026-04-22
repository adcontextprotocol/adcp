---
---

Lock in the error-claim-release invariant in `universal/idempotency.yaml` so the storyboard is no longer silent on what happens when a mutating request errors. Adds a fifth narrative bullet documenting that error responses (returned envelopes, thrown envelopes, uncaught exceptions) MUST NOT cache — the next request carrying the same key re-executes the handler — and calls out the handler-author mutate-last contract. Adds a reviewer check on `key_reuse_conflict` so reviewers verify the behavior via documentation or manual probe.

Closes the conformance gap flagged in adcontextprotocol/adcp#2760: a seller that silently cached error responses could pass conformance today, locking buyers into stale errors across out-of-band remediation (e.g., a buyer paying their invoice to clear `ACCOUNT_PAYMENT_REQUIRED`). An end-to-end programmatic phase is deferred until a generic force-error controller verb exists across specialisms.
