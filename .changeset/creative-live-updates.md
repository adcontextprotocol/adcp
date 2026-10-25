---
"adcontextprotocol": minor
---

Experimental live creative updates (#8404, folds in staged activation from #6780). A buyer changes a creative that is serving by syncing it again under the same `creative_id`; the seller declares in `creative.live_updates` which kinds of change (`click_through`, `trackers`, `asset_content`, `format`) it applies in place and how the creative serves meanwhile: `uninterrupted` (decided inside the sync call), `staged` (the approved prior version keeps serving until the change is approved, then is promoted atomically; `on_rejection` is `keeps_prior` or `stops`), or `paused_for_review` (the existing lifecycle). Name and tag changes are always accepted.

- `list_creatives` returns exact per-creative `live_updates` on every live creative and `staged_update` while a staged change awaits promotion; `sync_creatives` returns `staged_update` on the item; `dry_run` returns the same outcome.
- New error code `CREATIVE_LIVE_UPDATE_UNSUPPORTED` (with `error-details/creative-live-update-unsupported.json`) replaces `INVALID_STATE` for declaring sellers; non-declaring sellers are unchanged.
- `creative.status_changed` gains `staged_update.outcome` and permits `approved → approved` for staged promotion or keeps-prior rejection.
- `comply_test_controller` `force_creative_status` forces a pending staged update's review outcome.
- New storyboards `media_buy_seller/creative_live_updates` and `media_buy_seller/creative_live_update_refusal`; the training agent's sales tenant implements the surface.
