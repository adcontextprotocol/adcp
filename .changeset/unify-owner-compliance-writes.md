---
---

PR 1 of 4 in the compliance-state unification initiative (issue #4247): owner-triggered
`evaluate_agent_quality` runs now write to canonical compliance tables
(`agent_compliance_status`, `agent_compliance_runs`, `agent_storyboard_status`) with
`triggered_by = 'owner_test'`, closing the 12-hour gap between owner tests and the
public `/api/registry/agents/:url/compliance` endpoint. Non-owner runs continue
writing to `agent_test_history` (deprecated in PR 3). Adds `'owner_test'` to both
`triggered_by` CHECK constraints via migration 471.
