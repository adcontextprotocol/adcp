---
---

Fix `/api/registry/operator` and `/api/registry/agents` to recognize WorkOS OIDC access tokens in the `Authorization: Bearer` header, not just API keys and sealed sessions. Previously, authenticated OAuth clients silently fell through to public-only visibility — `scope3.com` returned `agents: []` for a valid member JWT while returning 16 agents for an `sk_*` API key from the same org. The shared `resolveCallerOrgId` helper now extracts `org_id` from the verified JWT (via WorkOS JWKS) before falling back to API key or session-user lookup.
