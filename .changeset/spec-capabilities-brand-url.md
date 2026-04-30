---
---

Add `specs/capabilities-brand-url.md` proposing a top-level `brand_url` on `get_adcp_capabilities` so verifiers can bootstrap from an agent URL to the operator's brand.json (and from there to signing keys) without out-of-band knowledge. Includes verifier algorithm with eTLD+1 origin binding + mandatory `identity.key_origins` consistency check, multi-tenant operator handling via `authorized_operators[]`, and a self-hostable AAO reference resolver (`/api/registry/agents/resolve`, `/api/registry/agents/jwks`) framed as a convenience layer not a trust anchor. No protocol changes ship in this PR — spec only.
