---
"adcontextprotocol": minor
---

Rewrite `media_buy_seller/dependency_impairment` phase 5 to use **swap-assignment** as the canonical recovery vector instead of same-ID re-approval. In production, buyers rarely re-approve a rejected creative on the same ID — they ship a corrected asset under a new ID and update the package's `creative_assignments`. The previous scenario modeled an uncommon flow and would have failed sellers whose review pipeline treats `rejected` as a hard wall (a legitimate design).

New phase 5 sequence:
1. Sync a second creative (B, approved) into the library — not yet assigned.
2. Force B to `approved` baseline via `comply_test_controller`.
3. Call `update_media_buy` with `packages[].creative_assignments` (replacement semantics per `package-update.json`) to swap the package's binding from A (rejected) to B (approved).
4. Read the buy — `health: ok`, `impairments[] empty`. Creative A's library status stays `rejected` but A is no longer a dependency of any package on this buy, so the impairment clears.

Scenario `version` bumped 1.0.0 → 2.0.0 to mark the recovery semantics change. `required_tools` adds `update_media_buy`. Narrative explicitly notes that same-ID re-approval is covered by a future opt-in sibling scenario (`media_buy_seller/dependency_impairment_reapprove_recovery`) for sellers whose review flow supports the reinstatement path.

Closes #4682.
