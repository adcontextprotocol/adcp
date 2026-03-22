---
"adcontextprotocol": minor
---

Add order lifecycle management to the Media Buy Protocol.

- `confirmed_at` timestamp on create_media_buy response (required) — a successful response constitutes order confirmation
- Cancellation via update_media_buy with `canceled: true` and optional `cancellation_reason` at both media buy and package level
- `canceled_by` field (buyer/seller) on media buys and packages to identify who initiated cancellation
- `canceled_at` timestamp on packages (parity with media buy level)
- Per-package `creative_deadline` for mixed-channel orders where packages have different material deadlines (e.g., print vs digital)
- `valid_actions` on get_media_buys response — seller declares what actions are permitted in the current state so agents don't need to internalize the state machine
- `get_media_buys` MCP tool added to Addie for reading media buy state, creative approvals, and delivery snapshots
- `revision` number on media buys for optimistic concurrency — callers pass in update requests, sellers reject on mismatch
- `status` field on update_media_buy response to confirm state transitions
- Formal state transition diagram and normative rules in specification
- Valid actions mapping table in specification and get_media_buys docs
- Curriculum updates: S1 (lifecycle lab), C1 (get_media_buys + lifecycle concepts), A2 (confirmed_at + status check step)
- 6 missing error codes added to enum: INVALID_STATE, NOT_CANCELLABLE, MEDIA_BUY_NOT_FOUND, PACKAGE_NOT_FOUND, VALIDATION_ERROR, BUDGET_EXCEEDED
