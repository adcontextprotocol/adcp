---
"adcontextprotocol": patch
---

chore(deps): bump @adcp/sdk 7.7 → 7.10.2 — catches the spec repo up on the 7.x line.

Pulls in 7.8's `impairment.coherence` audience-inverse grading + `creative_approvals[]` walk, 7.8's `ctx.input` surface on v6 platform methods (adoption in our v6 shims is a follow-up), 7.9's `pgCtxMetadataStore.resource` round-trip, and 7.10's `fetchAgentAuthorizationsFromDirectory` + typed `AGENT_SUSPENDED`/`AGENT_BLOCKED` codes. 7.10.0/7.10.1 had v2/projection packaging gaps that crashed `/sales` storyboards; both fixed via adcp-client#1909 (catalog) and adcp-client#1917 (registry).

Spec-side behavior unchanged; storyboard floors held without modification.
