---
---

Make member agent registration self-explanatory.

- Rename the dashboard CTA from "+ Add agent" to "+ Register agent" so the action matches the registry concept.
- Replace the seed prompt sent to Addie. Old: `I want to add an agent for compliance monitoring.` (compliance framing was nonsensical for first-time registration). New: `I want to register an agent in the AAO registry. What information do you require?` Updated in `dashboard-agents.html` (header CTA, empty-state CTA) and `org-health.ts` (org-health quick action).
- Teach Addie to drive a structured intake when a user asks to register: agent URL → auth method (none / bearer / basic / OAuth client credentials / OAuth user) → matching auth fields → protocol. Type is auto-detected by capability probe and is no longer asked.
- Add a "Quickstart: register your agent (members)" section at the top of `docs/registry/registering-an-agent.mdx` with the explicit sign-up → sign-in → `/dashboard/agents` → `+ Register agent` path, plus what Addie will ask.
