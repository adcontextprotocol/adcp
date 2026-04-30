---
---

Membership invitation lifecycle is now reflected on the recipient's `person_events` timeline. Sending, accepting, and revoking an invite each emit an event keyed to a stable `invite_id` UUID; an hourly sweep emits `invite_expired` events for invites that pass their `expires_at` without acceptance or revocation. A backfill script populates events for existing invites. Foundation for surfacing invite history in the admin UI and for Addie's memory layer (issue #3588).
