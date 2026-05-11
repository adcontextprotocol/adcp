---
"adcontextprotocol": minor
---

spec(idempotency): add normative rules for concurrent retries and downstream reconciliation; introduce `IDEMPOTENCY_IN_FLIGHT`

Two new normative rules in `L1/security.mdx#idempotency`:

**Rule 9 — Concurrent retries / first-insert-wins.** A second request carrying the same `(authenticated_agent, account_id, idempotency_key)` MAY arrive while the first is still executing. Sellers MUST resolve the race deterministically (`INSERT … ON CONFLICT DO NOTHING` on the scope tuple) and MAY pick one of two policies, behaving consistently: **wait-and-replay** (block the second request until the first completes, return cached response with `replayed: true`), or **reject-and-redirect** (return new `IDEMPOTENCY_IN_FLIGHT` code with `error.details.retry_after`). Same key with a *different* canonical payload during the in-flight window still returns `IDEMPOTENCY_CONFLICT` (rule 5). Verified against the canonical Python sales-agent (Wonderstruck) — its wait-and-replay implementation passes the new rule out of the box.

**Rule 10 — Crossing service boundaries / downstream reconciliation.** When a seller invokes a downstream system (SSP, ad server, payment provider) during request handling, "errors don't cache" (rule 3) is necessary but not sufficient — a crash between downstream-accepts and local-persist leaves the seller in a "downstream unknown" state. Sellers MUST adopt one of two patterns for every downstream call whose duplicate-invocation has business consequences: **write-claim-before-invoke** (persist a claim row with `downstream_request_id` before invoking; reconcile on retry by querying the downstream by that id) or **thread-buyer-key** (pass the buyer's `idempotency_key` or a deterministic seller-side derivative as the downstream's own idempotency key). The pattern "best-effort dedup on downstream response inspection" is explicitly forbidden.

**New error code: `IDEMPOTENCY_IN_FLIGHT`** (held for 3.1 per the wire-stability policy). Recovery: transient. Buyers MUST retry with the **same** `idempotency_key` after `error.details.retry_after` — minting a fresh key on this code turns a safe retry into a double-execution race.

**Transitional note on `SERVICE_UNAVAILABLE + retry_after`.** Both reference implementations today (the Python sales-agent at `wonderstruck.sales-agent.scope3.com` and the `@adcp/sdk` middleware) implement wait-and-replay (rule 9's other policy) and never need to emit `IDEMPOTENCY_IN_FLIGHT`. SDKs that previously emitted `SERVICE_UNAVAILABLE + retry_after: 1` on the in-flight branch are NOT out of compliance with rule 9 as long as they adopt wait-and-replay end-to-end — `IDEMPOTENCY_IN_FLIGHT` is only required when a seller picks reject-and-redirect. The `@adcp/sdk` middleware swap from `SERVICE_UNAVAILABLE` to `IDEMPOTENCY_IN_FLIGHT` is tracked separately (adcp-client follow-up); it's a wire-code tightening, not a behavioral change.

**Storyboard coverage.** `static/compliance/source/universal/idempotency.yaml` gains a `concurrent_retry` phase using two new cross-response check kinds (`cross_response_count_distinct`, `cross_response_field_equal`) that operate on the resolved response set across N parallel dispatches. The runner contract is documented in the new `test-kits/parallel-dispatch-runner.yaml`; runners without parallel-dispatch support skip the phase with a stable not_applicable marker. SDK/runner implementation tracked separately (adcp-client follow-up).

Author skill (`skills/call-adcp-agent/SKILL.md`) and the buyer-facing `docs/protocol/calling-an-agent.mdx` updated so buyers know to wait-and-retry on `IDEMPOTENCY_IN_FLIGHT` rather than mint a fresh key.
