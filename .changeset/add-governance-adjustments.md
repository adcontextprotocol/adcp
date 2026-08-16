---
"adcontextprotocol": minor
---

Add attributed delivery reconciliation and a two-party, append-only campaign adjustment lifecycle for AdCP 3.2. Sellers report canonical delivery statements and evidence-bound adjustments; buyers submit separate observations, close operational governance periods without asserting final billing truth, and accept or dispute adjustments. Audit logs expose discrepancies, period state, conservative exposure, gross commitment, verified economic reductions, and accounting-mode-specific headroom without weakening sticky trailing-window fragmentation defense.

## Migration

This change breaks three experimental surfaces (`x-status: experimental`). All three are changed for the first time in 3.2 beta, making the beta publication itself the required 6-week-notice vehicle per `docs/reference/experimental-status.mdx`.

**`report_plan_outcome` request `delivery` object** (`report-plan-outcome-request.json`): The deprecated unbound delivery snapshot is superseded by a required buyer-attributed observation. Before: `deprecated: true`, `additionalProperties: true`, no required fields. After: `additionalProperties: false` with six required fields (`observation_id`, `source`, `observed_at`, `reporting_period`, `cumulative_spend`, `currency`), plus `seller_statement_id`/`seller_statement_digest` required when `source` is `seller_statement_copy`.

```json
// Before (any shape accepted)
{ "delivery": { "media_buy_id": "mb_123", "impressions": 4200000, "spend": 137500 } }

// After (minimum required)
{
  "delivery": {
    "observation_id": "obs_001",
    "source": "buyer_measurement",
    "observed_at": "2026-03-22T01:05:00Z",
    "reporting_period": { "start": "2026-03-15T00:00:00Z", "end": "2026-03-22T00:00:00Z" },
    "cumulative_spend": 12500,
    "currency": "USD"
  }
}
```

**`check_governance` request `delivery_metrics`** (`check-governance-request.json`): Required fields expand from 1 (`reporting_period`) to 7: `statement_id`, `statement_digest`, `sequence`, `issued_at`, `reporting_period`, `cumulative_spend`, `currency`. (`seller_reference` and `canonical_payload` are not `delivery_metrics` request fields — they exist only on the response's `delivery_statement`.)

```json
// Before
{ "delivery_metrics": { "reporting_period": { "start": "2026-03-15T00:00:00Z", "end": "2026-03-22T00:00:00Z" } } }

// After
{
  "delivery_metrics": {
    "statement_id": "stmt_001",
    "statement_digest": "sha256:4b55f1157094ed8df2635250f71568701d294cb0da57845eba886a62e5434633",
    "sequence": 1,
    "issued_at": "2026-03-22T00:05:00Z",
    "reporting_period": { "start": "2026-03-15T00:00:00Z", "end": "2026-03-22T00:00:00Z" },
    "cumulative_spend": 12500,
    "currency": "USD"
  }
}
```

**`report_plan_outcome` with `outcome: "delivery"`** (`report-plan-outcome-request.json`): `check_id` and `governance_context` are now unconditionally required for this outcome. Previously both could be omitted, which allowed a delivery observation with no bound plan-owner check — the both-or-neither plan-owner path.

```json
// Before (accepted without check_id/governance_context)
{ "plan_id": "plan_1", "idempotency_key": "outcome-delivery-001", "outcome": "delivery", "delivery": { /* ... */ } }

// After (both required)
{
  "plan_id": "plan_1",
  "idempotency_key": "outcome-delivery-001",
  "check_id": "chk_seller_delivery_001",
  "governance_context": "gc_mb_seller_456",
  "outcome": "delivery",
  "delivery": { /* ... */ }
}
```
