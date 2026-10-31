---
"adcontextprotocol": minor
---

Experimental live creative updates (#8404, folds in staged activation from #6780). A buyer changes a creative that is serving by syncing it again under the same `creative_id`; the seller declares in `creative.live_updates` which kinds of change (`click_through`, `trackers`, `asset_content`, `format`) it applies in place and how the creative serves meanwhile: `uninterrupted` (decided inside the sync call), `staged` (the approved prior version keeps serving until the change is approved, then is promoted atomically; `on_rejection` is `keeps_prior` or `stops`), or `paused_for_review` (the existing lifecycle). Name and tag changes are always accepted.

- `list_creatives` returns `staged_update` while a staged change awaits promotion; `sync_creatives` returns `staged_update` on the item; `dry_run` returns the exact outcome of one change. There is no per-creative policy readback: the capability is the general floor and `dry_run` answers for one change.
- New experimental notification type `creative.staged_update_changed` (`creative/creative-staged-update-changed-webhook.json`) reports a staged update's review outcome (`promoted` or `rejected`), only to subscribers that register it. `creative.status_changed` is unchanged: a staged outcome is not a status transition, so a buyer on an earlier release never receives an `approved → approved` fire its closed validator would reject.
- New error code `CREATIVE_LIVE_UPDATE_UNSUPPORTED` (with `error-details/creative-live-update-unsupported.json`) replaces `INVALID_STATE` for declaring sellers only. Sellers that do not declare `creative.live_updates` keep the original rule: creatives on active, non-paused packages cannot be updated, and the refusal is `INVALID_STATE`.
- `comply_test_controller` `force_creative_status` forces a pending staged update's review outcome.
- New storyboards `media_buy_seller/creative_live_updates` and `media_buy_seller/creative_live_update_refusal`; the training agent's sales tenant implements the surface.
