---
"adcontextprotocol": minor
---

spec(idempotency): declare `capabilities.idempotency.in_flight_max_seconds` so buyers can compute retry budgets

Closes #4406. Follow-up to #4402 (rules 9 + 10 + IDEMPOTENCY_IN_FLIGHT).

Rule 9 requires sellers to bound the lifetime of an in-flight idempotency row to their declared per-task handler timeout. That bound exists in every conformant seller's deployment but is not buyer-observable — `capabilities.idempotency` currently declares `replay_ttl_seconds` (1h–7d) only, which is far wider than a realistic handler timeout. A buyer that retries on `IDEMPOTENCY_IN_FLIGHT` must either pick an arbitrary retry budget or be told to wait up to the full `replay_ttl_seconds` ceiling.

This change adds an optional `in_flight_max_seconds` field to the `IdempotencySupported` branch of `adcp.idempotency`:

- **Optional in 3.1.** SDKs that don't see the field fall back to rule 9's order-of-magnitude SHOULD heuristic. Additive change; no existing seller is non-compliant for omitting it.
- **Required when `supported: true` in 4.0** — same migration path `replay_ttl_seconds` followed across the 2.x → 3.x boundary. Buyers get a guaranteed bound at the next major.
- **Bounded** `integer ≥ 1, ≤ 604800` at the schema layer; cross-field bound `≤ replay_ttl_seconds` is enforced by the composed-schema validation suite (JSON Schema cannot express field-relative bounds).
- **Forbidden on the `IdempotencyUnsupported` branch.** No replay window means no in-flight bound — mirrors the existing `replay_ttl_seconds` treatment.

Buyer SDKs use the declared value to:

- Cap individual retry waits on `IDEMPOTENCY_IN_FLIGHT` at this value rather than the much-wider `replay_ttl_seconds` ceiling.
- Surface meaningful "your retry will succeed or fail within N seconds" hints to operators.
- Treat any `error.details.retry_after` exceeding this value as a seller bug — the in-flight row cannot legitimately outlive the declared bound.

Rule 9 in `security.mdx` is updated to point at the new capability field as the primary retry-budget bound when declared; the order-of-magnitude heuristic remains the fallback for sellers that haven't yet adopted the field.
