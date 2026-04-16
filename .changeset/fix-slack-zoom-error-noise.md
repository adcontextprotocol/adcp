---
---

Fix noisy system errors from spec-insight-post job and Zoom API calls. Spec-insight-post now rotates across working groups that have Slack channels configured (least-recently-posted first) instead of targeting a hardcoded "general" slug that doesn't exist. Zoom API request failures no longer log at error level from the low-level request utility — callers already log at appropriate levels (error for real failures, info/warn for expected 404s), so the duplicate error log was triggering spurious alerts.
