---
---

Web-side watchdog that polls `/internal/jobs` on the worker every 60s and emits `logger.error` after 3 consecutive failures (so #admin-errors gets paged via the existing posthog auto-route). Closes the silent-death gap behind escalation #329 — the worker crashlooped for 6 days while every scheduled job (compliance heartbeat, escalation triage, weekly digest, announcement handlers, …) silently stopped firing and nothing alerted. Recovery transitions log at info so flapping doesn't spam.
