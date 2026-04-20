---
"adcontextprotocol": patch
---

Bind `governance_context` tokens to a `plan_hash` claim (SHA-256 over RFC 8785 JCS-canonicalized plan bytes) so a buyer who mutates a plan via `sync_plans` after approval cannot reuse the pre-mutation intent token against the new plan body. Sellers MUST recompute the hash over a pinned plan revision and reject with `PLAN_HASH_MISMATCH` on mismatch. Adds `UPDATE_REQUIRES_GOVERNANCE` for `update_media_buy` changes to `bid_price`, `budget`, `daily_cap`, flight extension, or any `targeting` / `targeting_overlay` field — the governance agent (not the seller) decides whether the change is within plan authority. Adds a canonical plan → JCS bytes → SHA-256 test-vector fixture (`static/test-vectors/governance-plan-hash.json`). Schema additions: `plan_hash` field on `check_governance` response (informational; sellers MUST NOT verify against it); `PLAN_HASH_MISMATCH` and `UPDATE_REQUIRES_GOVERNANCE` in the error-code enum.

**Anchor-link break**: the seller verification checklist renumbers steps 13-15 to 14-16 to insert the plan-hash check. External references to `#step-13` / `#step-14` / `#step-15` now point to different items. Consumers MUST re-anchor against the current numbering.
