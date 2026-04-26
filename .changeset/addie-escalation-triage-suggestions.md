---
---

Addie now runs a daily escalation triage pass that writes suggested
resolutions (resolve / wont_do / keep_open) for open escalations older
than 7 days. Suggestions land in a new `escalation_triage_suggestions`
table — admins review them at `/admin/escalations/triage` and one-click
accept or reject. Nothing is auto-resolved: the job is suggest-only so
every close still has an operator behind it.

The MVP classifier is rule-based (URL probe against agenticadvertising.org,
referenced-escalation chasing, stale-ops age heuristic) — the same rules
used to clean up the 73 stale escalations on 2026-04-24. An LLM
classification pass can layer on later without changing the suggestion
schema.
