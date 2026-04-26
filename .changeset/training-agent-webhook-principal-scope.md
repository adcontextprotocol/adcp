---
---

Training agent now scopes webhook `operation_id` (and therefore the receiver-facing `idempotency_key`) by the caller's principal — same scoping the request-side idempotency cache already applies. Closes a cross-tenant collision on the shared sandbox token where two callers landing on the same deterministic response entity id would emit webhooks with identical idempotency_keys; receivers that dedupe across tenants on `idempotency_key` now see distinct events for distinct callers. The framework path delegates to `scopedPrincipal` so the partition format is defined in one place and cannot drift from the request-side cache. Fixes #2871.
