---
"adcontextprotocol": minor
---

Add optional assignment-scoped measurement `trackers` in AdCP 3.3 to package creative assignments and `sync_creatives` assignments and assign operations, gated by `creative.supports_assignment_trackers` (default false, requiring a creative library). Sellers fire them alongside the creative's own trackers without changing its revision or approval, enforce shared format tracker-slot limits, and reject assignments they cannot execute. Preserve omitted lists on additive upsert, replace supplied lists, and clear through atomic unassign/assign or complete package assignment replacement. Return the assignment-only tracker list from `list_creatives` and `get_media_buys`. The shared pixel event vocabulary also carries future playback events when added; certification buyer and seller creative modules can teach the new workflow through the updated task references.
