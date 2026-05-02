---
"adcontextprotocol": minor
---

Add `identity.brand_json_url` to `get_adcp_capabilities` response — capabilities-level pointer to the operator's brand.json so verifiers can bootstrap from an agent URL to that agent's signing keys without out-of-band knowledge of the operator domain. Closes the discovery gap in the request-signing chain (capabilities → `identity.brand_json_url` → brand.json → `agents[]` → `jwks_uri` → JWKS).

**What's new in `static/schemas/source/protocol/get-adcp-capabilities-response.json`:**
- New `brand_json_url` field inside the existing `identity` block (HTTPS URI). Co-located with `identity.key_origins`, `per_principal_key_isolation`, `compromise_notification` — all the trust-posture fields that depend on it. Naming intentionally distinguishes from `sponsored_intelligence.brand_url`: `brand_url` is reserved for "the brand being advertised" contexts; `brand_json_url` names the file artifact (the operator's brand.json), independent of whether the operator is a single brand, a house, an agency, or a pure operator record.
- Schema-optional in 3.x; storyboard-enforced when the agent declares any signing posture (`request_signing.supported_for`/`required_for` non-empty, `webhook_signing.supported === true`, or any `identity.key_origins` subfield). Becomes schema-required in 4.0 for responses declaring `supported_versions` containing any 4.x release.
- Structured constraints (required-when rules, verifier constraints, distinct-from relationships) lifted into a new `x-adcp-validation` extension keyword on the field. Codegen consumers get a tight 2-sentence JSDoc; the storyboard runner and SDK validators consume the structured rules programmatically. See `docs/reference/schema-extensions.mdx` for the convention.

**What's new in `docs/building/implementation/security.mdx`:**
- §"Discovering an agent's signing keys via `brand_json_url`" — 8-step verifier algorithm with eTLD+1 origin binding (pinned PSL snapshot required), `authorized_operators[]` opt-in for SaaS-platform-as-operator deployments, mandatory `identity.key_origins` consistency check (purpose-AND-role, with sell-side webhook publisher-pin carve-out), no-redirect rule on brand.json fetch, body cap and timeout budgets, negative-cache 60s floor.
- Eight new `request_signature_*` rejection codes with detail fields and remediation column: `brand_json_url_missing`, `capabilities_unreachable`, `brand_json_unreachable`, `brand_origin_mismatch`, `agent_not_in_brand_json`, `brand_json_ambiguous`, `key_origin_mismatch`, `key_origin_missing`.
- Trust-root distinction: brand.json operator-attested; adagents.json publisher-attested; agent never self-attests.
- Quickstart subsection mirroring §796 — 6 numbered steps + 15-line pseudocode for implementing a `brand_json_url`-based verifier.
- Reference-implementation paragraph naming `@adcp/client` (TypeScript), `adcp` (Python), `adcp-go` (Go) with their `resolveAgent` / `getAgentJwks` / `verify_request_signature` signatures and the `npx @adcp/client resolve <url>` CLI.

**Backwards compatibility:** Strictly additive. Verifiers that ignore `identity.brand_json_url` continue to work. The full design (with reviewer history, multi-tenant operator handling, SDK + CLI integration, naming-convention discussion, and rejected hosted-AAO-resolver alternative) is in `specs/capabilities-brand-url.md`.
