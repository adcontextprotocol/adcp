---
id: DR-0023
title: A signing agent's identity is an origin, discovered through Web Bot Auth, with a derived trust record
class: normative
status: proposed
date: 2026-10-10
decided_by: pending WG ratification (first WG working session)
refs: ["#8118", "#7878", "#7817", "#7809", "#7942", "#6105", "PR #8119", "PR #7894"]
dissent: "The #7878 author prefers deprecating the 3.2 signing profile in 3.3; this record keeps it undeprecated through 3.x."
---

## Decision

For AdCP 3.3, first-contact signer identity uses an optional, experimental, capability-advertised Web Bot Auth profile:

- **The signer names its origin** in a covered `Signature-Agent` header.
- **The verifier fetches keys from that origin's directory.** The location is `/.well-known/http-message-signatures-directory`.
- **The verifier derives the operator's trust record** at `https://{eTLD+1(origin)}/.well-known/trust.json`. It does not call the signer's `get_adcp_capabilities`.

An identity is an origin: one agent per origin, one key purpose per origin. Keys appear only in the directory, so trust.json v1 carries no `jwks_uri`.

**What verification grants.** A verified identity the seller has not bound gets what an anonymous caller gets, reads included. Authority comes from seller binding and from grants.

**Scope.** In 3.3 the profile covers HTTP requests and webhooks. JWS document signing moves in 3.4.

**Alternatives superseded.** This decision supersedes `adcp-agent-url` (#7817) and the client-only bootstrap (#7942). The 3.2 profile (brand.json, `identity.brand_json_url`, `jwks_uri`) stays valid and undeprecated through 3.x, under a no-downgrade rule keyed by origin.

## Rationale

The 3.2 discovery chain starts by calling the signer, so every signing buyer must run a capabilities endpoint. It also gives a seller no way to identify a signer it has not onboarded.

Taking identity from the origin collapses key discovery to one fetch. Because one agent occupies one origin, and the registrable-domain owner controls every origin under it, the operator record can be derived instead of pointed to. That removes both the capabilities dependency and the ambiguity of several records listing one agent.

Web Bot Auth is the IETF-adopted mechanism for exactly this header, directory, and fetch model. Adopting it avoids an AdCP-only header that 4.0 would retire.

## Implications

The design spec is `specs/agent-identity-3-3.md`. It defines the rules (R1–R9), the threat-model deltas, and the P1–P9 implementation plan. The decision is taken at the first WG working session (decision brief on #7878); PR #8119 then records it.

**This record settles:**
- origin identity;
- derived trust records;
- that verification alone grants no authority;
- 3.2 coexistence without deprecation in 3.3.

**This record does not settle:**
- JWS document signing and governance-key provenance (3.4);
- transparency logs;
- the 4.0 removal timetable beyond `specs/brand-identity-trust-split.md`;
- the onboarding-posture shape, which ships as its own experimental feature.
