---
---

feat(crawler): include adagents_json-sourced discovered_agents in the periodic probe set (#4849)

The periodic probe loop (`refreshAgentSnapshots`) walks `listAllAgents()`, which only returns agents from `member_profiles.agents` (the configured / seed set). Agents that exist only in `discovered_agents` — like `interchange.io`, which is named only in cafemedia's `publisher_properties[]` selector and never appears in any sales-agent's `list_authorized_properties` — never enter the probe set.

Result: capability + health snapshots, `agent_type` promotion, and signing-key-pin freshness all stop at the seed boundary. A manager-file-only agent's index entry sits frozen at first-seen.

**Fix.** New `FederatedIndexService.listAllProbeableAgents()` unions:

1. `listAllAgents()` — registered seed set (unchanged surface for everything else)
2. `discovered_agents` where `source_type = 'adagents_json'` — agents we learned about by parsing some publisher's `adagents.json`

`source_type = 'list_authorized_properties'` (`agent_claim`) is **intentionally excluded** — those are unverified peer claims; probing them creates churn without bilateral confirmation. Member-profile metadata wins on URL collision (richer name / type / visibility data).

`refreshAgentSnapshots` switches to the new method. No other caller of `listAllAgents` is touched.

**Test coverage** (`server/tests/integration/federated-index-probeable-agents.test.ts`):
- `adagents_json` discovery → included
- `list_authorized_properties` discovery → excluded
- URL collision → member profile wins
