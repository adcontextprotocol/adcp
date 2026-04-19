---
---

fix(training-agent): close idempotency-enforcement drift on `si_initiate_session`, `si_send_message`, `sync_audiences`

The hand-maintained `MUTATING_TOOLS` set in `server/src/training-agent/idempotency.ts` had drifted from the schemas that define which requests require `idempotency_key`. Three tools whose top-level `required` arrays include `idempotency_key` — `si_initiate_session`, `si_send_message`, `sync_audiences` — were missing, so any retry of those tools after a 5xx could double-execute without hitting the replay / conflict / expired path.

Adds the missing tools and a regression test that re-derives the set from `static/schemas/source/**/*-request.json` at test time, so future schema changes without corresponding code updates fail CI instead of silently bypassing enforcement.
