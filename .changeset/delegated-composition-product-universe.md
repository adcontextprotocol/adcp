---
"adcontextprotocol": minor
---

Add first-class support for delegated composition — a requesting platform that owns the sellable catalog asking an external agent to supply only the composition judgment (#7107). `criteria.product_ids_exclusive` makes `product_ids` the complete composable universe rather than a candidate hint: every proposal purchase and echoed product must reference it, an unsatisfiable brief returns `rejected` or `constraint_unsatisfiable`, and sellers not declaring the new `media_buy.supports_exclusive_product_ids` capability reject the flag with `UNSUPPORTED_FEATURE` instead of silently ignoring it. `media_buy.proposal_refinement.hold_semantics` (`inventory_hold` | `terms_only`) lets a seller that holds no inventory declare terms-only finalize: the same atomic all-or-none batch commits commercial terms without placing holds, `hold_unavailable` and hold-driven `batch_aborted` are excluded, and reservation is owned by the requesting side.
