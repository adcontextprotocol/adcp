---
"adcontextprotocol": minor
---

Add attributed delivery reconciliation and a two-party, append-only campaign adjustment lifecycle for AdCP 3.2. Sellers report canonical delivery statements and evidence-bound adjustments; buyers submit separate observations, close operational governance periods without asserting final billing truth, and accept or dispute adjustments. Audit logs expose discrepancies, period state, conservative exposure, gross commitment, verified economic reductions, and accounting-mode-specific headroom without weakening sticky trailing-window fragmentation defense.

## Migration

This change breaks two experimental surfaces (`x-status: experimental`). Both surfaces are changed for the first time in 3.2 beta, making the beta publication itself the required 6-week-notice vehicle per `docs/reference/experimental-status.mdx`.

**`delivery` object** (`check-governance-response.json` / `get-plan-audit-logs-response.json`): The deprecated unbound delivery snapshot is superseded. Before: `additionalProperties: true`, no required fields (`deprecated: true`). After: six required fields (`statement_id`, `sequence`, `statement_digest`, `reporting_period`, `cumulative_spend`, `currency`), `additionalProperties: false`.

**`check_governance` `delivery_metrics`**: Required fields expand from 1 (`reporting_period`) to 8 (`statement_id`, `sequence`, `statement_digest`, `reporting_period`, `cumulative_spend`, `currency`, `seller_reference`, `canonical_payload`). Before/after request examples are in `docs/governance/campaign/tasks/check_governance.mdx`.
