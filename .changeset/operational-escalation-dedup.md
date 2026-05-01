---
---

Add operational escalations with deduplication, and route Slack `not_in_channel` to that path so the signal stays visible without paging.

**Schema (migration 459):** new `dedup_key TEXT` column on `addie_escalations`, plus a partial unique index on `(dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('open','acknowledged','in_progress')`. Lets the same key be reused once the prior escalation is resolved.

**`createEscalation`:** accepts an optional `dedup_key`. If an open/acknowledged/in-progress escalation already exists with that key, returns the existing row instead of inserting. Falls back through the partial unique index if a race causes a 23505.

**`inviteToChannel` (Slack):** when Slack returns `not_in_channel`, fire-and-forget creates an escalation with `category='needs_human_action'`, `priority='low'`, `dedup_key='slack:not_in_channel:${channelId}'`. The bot needs to be invited (or the calling code needs to stop) — actionable, but not page-worthy. Other expected Slack codes (`channel_not_found`, `is_archived`, `user_disabled`, etc.) stay at `warn` only — they're user-side, not operator-side.
