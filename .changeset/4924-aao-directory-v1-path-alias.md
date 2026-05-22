---
---

fix(server): mount AAO directory inverse-lookup at spec-conformant /v1/agents path

Adds a /v1/agents/:encodedUrl/publishers route alongside the existing /api/v1/agents/... path so spec-conformant SDK clients (adcp-client-python fetch_agent_authorizations_from_directory) work without the /api-prefix workaround. Keeps /api/v1/... for backward compat and documents both OpenAPI paths, with /v1/agents/... as the spec-conformant operation.
