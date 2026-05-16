---
---

`upsertMembership` (the `organization_membership.created` webhook handler) now enforces seat-cap on un-staged adds — WorkOS adds that bypass our invite endpoints (SSO domain auto-join, dashboard direct add, API direct add) get refused locally and surfaced to org admins via Slack instead of silently squeezing past the cap. Adds previously routed through our invite endpoints still bypass this check (the cap was already enforced at issue time and the row in `invitation_seat_types` reserved the seat). Closes #3967.
