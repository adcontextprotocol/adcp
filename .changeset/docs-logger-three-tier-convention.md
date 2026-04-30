---
---

Extend the `logger` JSDoc convention added in #3650 with the three-tier failure-handling model that emerged across PRs #3578, #3622, #3648, #3664, and #3672:

- Tier 1 — `logger.error` — unexpected failures that page on-call
- Tier 2 — `logger.warn` (no escalation) — expected third-party state we accept
- Tier 3 — `logger.warn` + `createEscalation({ category: 'needs_human_action', dedup_key })` — actionable but not page-worthy, lands in the escalation queue with collapse semantics

Docs-only. Future authors writing tool handlers or third-party-API wrappers now have a single reference for which tier to pick. Example call site for tier 3: `slack/client.ts:inviteToChannel`.
