---
"adcontextprotocol": patch
---

Clarify what happens when more than one `authorized_agents[]` entry in `adagents.json` matches the same agent (adcp#8943), for example an origin-only entry and an entry with the agent's full URL: each matching entry authorizes the agent, and the agent's scope is the union of their scopes. A narrower entry never removes scope that another matching entry grants. Updated: the Agent URL matching section of `docs/governance/property/adagents.mdx` and the origin-only entry in `docs/reference/migration/3-2-to-3-3.mdx`.
