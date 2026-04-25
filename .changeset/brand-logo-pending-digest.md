---
---

New scheduled job `brand-logo-digest` posts a daily summary to the configured admin Slack channel when brand logos have been sitting in moderation review for more than 12 hours. Uses the existing in-process scheduler (`server/src/addie/jobs/scheduler.ts`) and the same `getAdminChannel()` system setting other admin alerts use.

The pending queue was previously invisible — `getPendingLogos` had zero callers before #3137, and admins won't poll `list_pending_brand_logos` on their own. The 12-hour threshold gives #3154's auto-approve path time to handle owner uploads without surfacing them in the digest. Items younger than 12h, or runs where the queue is empty, produce no Slack noise.

Closes #3151.
