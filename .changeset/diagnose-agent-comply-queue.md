---
---

New one-off script `server/src/scripts/diagnose-agent-comply-queue.ts` that explains why a given agent URL isn't in the compliance-heartbeat queue. Mirrors `getAgentsDueForCheck` logic — checks union-source presence, metadata filters (lifecycle_stage, compliance_opt_out, monitoring_paused), current `agent_compliance_status`, and computes the agent's row-number in the next batch. `--requeue` flag clears `last_checked_at` to force pickup on the next tick. Built for escalation #329 follow-up where Evgeny's agent showed `last_checked_at = 2026-05-04` and we needed to know whether it was filtered out, queued behind NULLs, or never indexed.
