---
---

**Workflow B Stage 3 — admin "Mark posted to LinkedIn" action**

Closes the Workflow B loop: admins who post to LinkedIn *outside* Slack
can now click "Mark posted to LinkedIn" on the admin account detail page
and record the same `announcement_published` (channel=linkedin) row that
the Slack button writes.

**Shared critical section.** `markLinkedInPosted(orgId, actor)` is
extracted from the Slack Bolt handler (Stage 2) and called by both the
handler and the new HTTP route. Both paths hold the same advisory lock
keyed on `(orgId, 'mark_linkedin')` so admin double-clicks, Slack
retries, and cross-surface races converge on a single INSERT.

**Actor identity.** Metadata now discriminates the actor source — Stage
2 rows write `marked_by_slack_user_id` + `marked_via: 'slack'`; Stage 3
rows write `marked_by_workos_user_id` + `marked_via: 'admin'`. The review
card render path shows a clickable `<@U…>` mention for Slack-originated
marks and a plain-text "an AAO admin" for admin-UI marks (Slack can't
resolve WorkOS ids; leaking internal ids into a shared channel isn't
something we want). Legacy rows (no `marked_via`) are treated as
Slack-originated for back-compat.

The `announcement_skipped` and `announcement_published (slack)` rows
follow the same shape going forward: `skipper_slack_user_id` /
`approver_slack_user_id` with a matching `_via` field.

**Changes:**

- `server/src/addie/jobs/announcement-handlers.ts` — extracts the shared
  `markLinkedInPosted`; refactors `AnnouncementState` to carry tagged
  `StoredActor` objects instead of raw Slack user ids; adds
  `renderActorMention` helper; exports `loadDraftAndState`.
- `server/src/routes/admin/accounts.ts` — adds `POST /api/admin/accounts/:orgId/announcement/linkedin`; extends the account detail GET response with an `announcement` object.
- `server/public/admin-account-detail.html` — new "New-member
  announcement" collapsible card. Shows current state and surfaces
  the Mark-LI button when `slack_posted && !linkedin_posted && !skipped`.

6 new shared-function tests cover admin actor, Slack actor, legacy row
back-compat, and the three refuse paths. 86/86 announcement tests pass;
server typecheck clean.
