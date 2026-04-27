---
---

Two new Stage 2 prompt rules powered by community-engagement context.

**`event.upcoming_registered`** (priority 89, dynamic label/prompt + matchClick) — fires for members whose next registered event starts within 14 days. Renders "Prep for Cannes Lions" / "Cannes Lions is coming up. What do I need to know?" for an event titled "Cannes Lions"; falls back to a generic "Prep for your event" when title resolution fails.

**`perspectives.share_first_one`** (priority 55) — fires for active members (≥1 login in 30d) who have never published a perspective. Renders "Share what I'm building."

New MemberContext blocks: `perspectives` (`{ published_count, last_published_at }`) and `next_event` (`{ title, slug, starts_at }`). Both hydrated in Slack and web flows. Single-row queries, no new schema. 89 unit tests total (was 80; added 9 covering both rules + matchClick for the dynamic event prompt).
