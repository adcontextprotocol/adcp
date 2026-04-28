---
---

Add `governance_multi_agent_rejected` negative compliance scenario for the `governance-aware-seller` specialism.

Exercises `sync_governance` with two `governance_agents` entries (violating `maxItems: 1` from #3015) and expects `INVALID_REQUEST`. Without this scenario, a seller that silently accepts multi-agent registration passes all four happy-path governance scenarios while violating the one-agent-per-account invariant that the protocol envelope and `check_governance` lifecycle depend on.

Closes #3438.
