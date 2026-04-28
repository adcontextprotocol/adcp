---
"adcontextprotocol": patch
---

Fix `inventory_list_targeting` storyboard: replace hardcoded `idempotency_key` on `create_buy_with_lists` step with a per-run generated key (`$generate:uuid_v4#...`), matching the pattern already used by the `update_buy_swap_lists` step in the same file.

The hardcoded key `"inventory-list-targeting-create-v1"` caused `verify_create_persisted` to produce a false failure on spec-correct frozen-response sellers: on run N+1 the seller correctly replays the cached create response while `get_media_buys` reads mutated live state (left by run N's `update_swap_lists`), producing a mismatch that cannot be resolved seller-side without violating idempotency semantics.
