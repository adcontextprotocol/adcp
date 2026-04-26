---
---

Escalation triage can now suggest filing bug-shaped escalations as GitHub
issues. When a URL probe confirms the bug still repros (404/410 on the
referenced AAO page), the classifier emits a `file_as_issue` suggestion
with a pre-drafted title/body. Admins review the draft on
`/admin/escalations/triage` and one-click file — Addie creates the issue
via GITHUB_TOKEN, records the URL on the escalation, and marks it resolved.

The draft is built from Addie-authored fields only (summary + context) —
user PII (email, slack handle, display name, raw original request) is
excluded by construction.
