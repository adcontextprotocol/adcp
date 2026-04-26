---
---

Reject creative_assignments: [] on active/paused/pending_start media buys in the training agent.

Calling update_media_buy with an empty creative_assignments array on a live buy caused
deriveStatus to return pending_creatives (hasCreatives === false), an off-graph transition from
active not in MEDIA_BUY_TRANSITIONS. Now validated in the pre-pass: if the buy is in
active, paused, or pending_start status, clearing all assignments returns VALIDATION_ERROR
before any mutation occurs. Server-only change; no protocol schema impact.
