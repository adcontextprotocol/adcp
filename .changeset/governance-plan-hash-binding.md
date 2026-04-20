---
"adcontextprotocol": patch
---

Bind `governance_context` tokens to a `plan_hash` claim (SHA-256 over RFC 8785 JCS-canonicalized plan bytes) so a buyer who mutates a plan via `sync_plans` after approval cannot reuse the pre-mutation intent token against the new plan body. Sellers MUST recompute the hash and reject with `PLAN_HASH_MISMATCH` on mismatch. Adds `UPDATE_REQUIRES_GOVERNANCE` for `update_media_buy` price-affecting changes (`bid_price`, `budget`, `daily_cap`, flight extension, targeting broadening) that cross the approved envelope without a fresh `modification`-phase token. Schema additions: `plan_hash` field on `check_governance` response; `PLAN_HASH_MISMATCH` and `UPDATE_REQUIRES_GOVERNANCE` in the error-code enum.
