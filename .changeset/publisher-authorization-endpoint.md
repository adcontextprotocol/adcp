---
---

Adds `GET /api/registry/publisher/authorization?domain=X&agent=Y`. Returns
`{ publisher_domain, agent_url, authorized: N, total: M, publisher_wide,
source, authorized_for, unauthorized_properties[] }` so an external caller
can ask the focused question "is this agent authorized for this publisher,
and for which properties" without pulling the full `/api/registry/publisher`
payload.

404 when the agent has no authorization (publisher-wide or property-level)
for the domain.
