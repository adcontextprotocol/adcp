---
"adcontextprotocol": minor
---

Add optional assignment-scoped measurement `trackers` in AdCP 3.3 to `sync_creatives` `assignment_operations` `assign` operations, gated by `creative.supports_assignment_trackers` (default false, requiring a creative library). Sellers fire them alongside the creative's own trackers without changing its revision or approval, enforce shared format tracker-slot limits, and reject assignments they cannot execute. Preserve omitted lists on additive upsert, replace supplied lists, and clear through atomic unassign/assign. Return the assignment-only tracker list from `list_creatives` and `get_media_buys`. The shared pixel event vocabulary also carries future playback events when added.

Its copies on package creative assignments (`create_media_buy`, `update_media_buy`) and on `sync_creatives` `assignments[]`, published in beta.0 through beta.5, were withdrawn before 3.3.0 GA (#8758, #8767).
