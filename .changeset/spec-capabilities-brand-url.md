---
"adcontextprotocol": minor
---

Add `brand_url` to `get_adcp_capabilities` response — capabilities-level pointer to the operator's brand.json so verifiers can bootstrap from an agent URL to that agent's signing keys without out-of-band knowledge of the operator domain. Closes the discovery gap in the request-signing chain (capabilities → brand_url → brand.json → agents[] → jwks_uri → JWKS).

**What's new in `static/schemas/source/protocol/get-adcp-capabilities-response.json`:**
- Top-level `brand_url` (HTTPS URI) — schema-optional in 3.x, storyboard-enforced when the agent declares any signing posture (`request_signing.supported_for`/`required_for` non-empty, `webhook_signing.supported === true`, or any field under `identity.key_origins`). Becomes schema-required in 4.0.
- Distinct from the existing `sponsored_intelligence.brand_url`, which remains a rendering pointer for SI agent visuals.

**What's new in `docs/building/implementation/security.mdx`:**
- §"Discovering an agent's signing keys via `brand_url`" — 8-step verifier algorithm with eTLD+1 origin binding, `authorized_operators[]` opt-in for SaaS-platform-as-operator deployments, and mandatory `identity.key_origins` consistency check (purpose-generic, covers request-signing / webhook-signing / governance-signing / tmp-signing).
- Eight new `request_signature_*` rejection codes with detail fields: `brand_url_missing`, `capabilities_unreachable`, `brand_json_unreachable`, `brand_origin_mismatch`, `agent_not_in_brand_json`, `brand_json_ambiguous`, `key_origin_mismatch`, `key_origin_missing`.
- Trust-root distinction documented: brand.json is operator-attested; adagents.json is publisher-attested; agent never self-attests its own keys.

**Backwards compatibility:** Strictly additive. Verifiers that ignore `brand_url` continue to work. Spend-committing operations gain an enforceable trust-root pointer for buyers who haven't onboarded out-of-band with each seller. The full design (with reviewer history, multi-tenant operator handling, SDK + CLI integration, and rejected alternatives) is in `specs/capabilities-brand-url.md`.
