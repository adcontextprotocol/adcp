---
---

Add a daily scheduled job that DMs new paying members on days 3, 7, 14, and 30 after subscription activation until their AAO profile is public and their brand.json manifest exists. Stage 1 of the new-member announcement workflow (issue #2233, spec at `specs/new-member-announcements.md`). Honors `slack_user_mappings.nudge_opt_out` and a per-profile `metadata.no_announcement` flag. Idempotent via `org_activities` entries of type `profile_nudge_sent`.
