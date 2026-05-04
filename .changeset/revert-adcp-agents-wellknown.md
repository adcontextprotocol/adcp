---
---

Revert `/.well-known/adcp-agents.json` (#3903). Discovery questions are already covered by the existing well-knowns:

- "What agent sells inventory on `xxxxx.com`?" → `adagents.json`
- "What's the agent for `<entity>`?" → that entity's `brand.json` `agents[]`
- "Is this URL a real agent and what does it do?" → the agent's own `agent-card.json` / `get_adcp_capabilities`

A third origin-scoped manifest enumerating "all agents at this host" was justified primarily by a multi-tenant test fixture; in real deployments tenants are brands and each publishes their own `brand.json`. Removing before any non-training-agent implementations adopt it.
