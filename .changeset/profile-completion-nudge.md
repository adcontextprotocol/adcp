---
---

Stages 1 and 2 of the new-member announcement workflow (issue #2233, spec at `specs/new-member-announcements.md`):

- Add a daily scheduled job that DMs new paying members on days 3, 7, 14, and 30 after subscription activation until their AAO profile is public and their brand.json manifest exists. Eligibility is "at least N days since signup, no prior nudge recorded for day N", so a missed run catches up on the next day. Each org receives at most one DM per run (highest-day-first). Honors `slack_user_mappings.nudge_opt_out`. Idempotent via `org_activities` entries of type `profile_nudge_sent`.
- Emit a `profile_published` `org_activities` entry when `member_profiles.is_public` transitions from not-public into public, on the create, update, and visibility-toggle paths. This is the trigger Workflow B will listen for in a follow-up PR.
