---
---

Two small polish items deferred from the PR #3450 review:

- **Click-tracking on "Report wrong"**: new endpoint `POST /api/organizations/:orgId/brand-classification-report` records `(orgId, userId, kind, subject_domain)` to `registry_audit_log` so we have a triage queue + can detect "10 different members reported the same domain." The frontend fires `navigator.sendBeacon` on click — the `mailto:` opens regardless. Member-or-above can flag (broader than admin/owner since the report is informational).
- **Deep link from `/member-profile` to `/team`**: tiny one-liner under "Brand identity" on the member-profile page pointing at the team page where the registry hierarchy is shown. Closes the bounce-off case where an admin lands on member-profile looking for "is my company classified right?"
