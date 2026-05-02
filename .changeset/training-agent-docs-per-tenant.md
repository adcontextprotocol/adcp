---
---

Update training agent URL references in docs to per-tenant endpoints. Follows the multi-tenant split shipped in `7974aeccd8`.

URL mapping by content focus:
- Quickstart, media-buy task references, generic auth examples → `/sales/mcp`
- Signals specialist module + ecosystem reference → `/signals/mcp`
- Governance specialist module → `/governance/mcp`
- Creative specialist module → `/creative/mcp` default, with notes pointing at `/creative-builder/mcp` and `/sales/mcp` for the lab exercises that target those agents
- Sponsored Intelligence specialist module → stays on legacy `/mcp` (multi-specialism lab, no dedicated SI tenant)

Spec doc `specs/brand-protocol-sandbox-agent.md` prose updated to describe the multi-tenant architecture.

The legacy `https://test-agent.adcontextprotocol.org/mcp` URL keeps working via the back-compat alias mounted in the same release.
