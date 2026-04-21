---
"adcontextprotocol": patch
---

Wire first cross-step assertions to `universal/idempotency` (adcp#2639).

The storyboard now declares `invariants: [idempotency.conflict_no_payload_leak, context.no_secret_echo]`, converting two reviewer-only checks — from the `key_reuse_conflict` phase's `reviewer_checks` block and the wider security guidance — into programmatic gates that fail the storyboard at runtime rather than waiting for human review.

- `idempotency.conflict_no_payload_leak` — an `IDEMPOTENCY_CONFLICT` error body must contain only allowlisted fields (`code`, `message`, `status`, `retry_after`, `correlation_id`, `request_id`, `operation_id`). Any `budget`, `start_time`, `product_id`, nested `cached_payload`, etc. is flagged — leaking cached state turns key-reuse into a read oracle for an attacker who stole a key.
- `context.no_secret_echo` — no response (success or error) may echo `Authorization: Bearer <token>` literals, verbatim copies of the test-kit's declared `api_key`, or suspect property names (`Authorization`, `api_key`, `bearer`, `x-api-key`) at any depth.

Assertion TS modules ship in `server/src/compliance/assertions/` and register against `@adcp/client/testing`'s assertion registry at import time. Runners (CLI `--invariants` or direct `runStoryboard` callers) must load the modules before running the storyboard; the runner throws at start on unresolved ids rather than silently skipping.

Bumps the `@adcp/client` dependency to `^5.8.1` to pick up the assertion-registry re-exports from `@adcp/client/testing`.
