---
"adcontextprotocol": minor
---

Add conformance surface for outcome_target reverse forecasting. The new `media_buy_seller/outcome_target` scenario (required by the sales-proposal-mode specialism, gated on `media_buy.outcome_target`) grades the answer contract: `total_budget_guidance` on every returned proposal and a forecast whose points carry the goal's metric or event key, with `forecast_range_unit` `clicks`/`conversions` structuring the curves. Fixes the canonical-proposal gap the contract exposed (#6745): `core/canonical-proposal.json` gains optional `total_budget_guidance` and `forecast`, restoring parity with the legacy proposal's planning outputs so the compact `request_proposals` lifecycle can actually express the answer. The training agent implements a deterministic reverse-forecast reference model.
