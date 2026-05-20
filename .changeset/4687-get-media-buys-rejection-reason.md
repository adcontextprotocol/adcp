---
"adcontextprotocol": patch
---

Surface `rejection_reason` on `get-media-buys-response.json#/properties/media_buys/items` — the field existed on `core/media-buy.json` but wasn't typed on the response schema, same gap-class as `health` + `impairments[]` fixed in PR #4685.

Audit of `core/media-buy.json` against `get-media-buys-response.json` items completed: every other field on `core/media-buy.json` (media_buy_id, account, status, health, impairments, confirmed_at, cancellation, total_budget, packages, invoice_recipient, creative_deadline, revision, created_at, updated_at, ext) is already mirrored on the response items. After this patch, the response schema is complete with respect to the canonical media-buy fields.

Response-specific additions (currency, start_time, end_time, valid_actions, available_actions, history, augmented packages with delivery snapshots) remain — those are deliberately on the response and not on `core/media-buy.json`.

Closes #4687.
