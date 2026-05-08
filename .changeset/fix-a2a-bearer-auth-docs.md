---
---

Corrects A2A authentication documentation to reflect the adcp 4.5.0
per-leg header convention: A2A requires `Authorization: Bearer <token>`
(RFC 6750) only; `x-adcp-auth` is a back-compat alias for MCP only.

Changes:
- `authentication.mdx`: splits "Protocol Configuration" to clarify
  the MCP vs A2A header alias policy and adds a seller migration note
  for the `a2a_header_name` knob.
- `a2a-guide.mdx`: updates `A2AClient` init snippet from legacy
  `apiKey:` field to `auth: { type: 'bearer', token: ... }`.
- `a2a-guide.mdx`: adds `securitySchemes` / `security` to the sample
  agent card so buyers see the correct `bearerAuth` declaration.
