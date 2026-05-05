---
---

Brandfetch upstream 5xx/429 responses now retry with exponential backoff and log at `warn` instead of `error`. Transient timeouts (e.g. 504 on `/brands/enrich`) no longer page on-call via the `#aao-errors` Slack hook.
