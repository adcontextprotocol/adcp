---
---

Admin thread search now matches across every natural identifier — full
name, Slack handle, Slack real name, WorkOS first/last name, or any
known email address. `listThreads({ user_search })` adds two LEFT JOINs
(slack_user_mappings, users) only when the filter is set, then
OR-matches the term against thread display name, raw user_id (which
carries the email for email threads), Slack mapping fields, and WorkOS
profile fields.

Without this, harmonizing `addie_threads.user_display_name` to
`Brian O'Kelley` (full WorkOS name) in #3271 orphaned admins who
typed a Slack handle like `bokelley` into the search box. The
underlying mapping was always there; the query just wasn't using it.

Eight new integration tests in `tests/unit/thread-service.test.ts`
cover Slack handle, Slack real name, Slack-side email, WorkOS first
name, WorkOS email, email-thread sender lookup, harmonized display
name across surfaces, and the negative case.
