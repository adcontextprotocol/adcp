---
id: DR-0023
title: A signing agent's identity is an origin, discovered through Web Bot Auth, with a derived trust record
class: normative
status: proposed
date: 2026-10-10
decided_by: pending WG ratification (WG working session 2026-10-12)
refs: ["#8118", "#7878", "#7817", "#7809", "#7942", "#6105", "PR #8119", "PR #7894"]
dissent: none recorded
---

## Decision

For AdCP 3.3, first-contact signer identity uses an optional, experimental, capability-advertised Web Bot Auth profile, implemented as the draft defines it with no AdCP additions to the WBA layer:

- **The signer names its origin** in a covered `Signature-Agent` header, with `tag="web-bot-auth"`. The tag applies to requests and webhooks alike.
- **Identity is complete when the signature verifies** under a key from that origin's directory (`/.well-known/http-message-signatures-directory`) and the origin's revocation list does not revoke it.
- **The operator's trust record is derived** at `https://{eTLD+1(origin)}/.well-known/trust.json`. It is evaluated where something is gated on it (binding, grants, `open` onboarding), never on the signature path. The verifier does not call the signer's `get_adcp_capabilities`.

**Identity is an origin.** One agent per origin, and a governance agent is its own agent. Keys appear only in the directory, so trust.json v1 carries no `jwks_uri`.

**What verification grants.** A verified identity the seller has not bound gets what an anonymous caller gets, reads included. Authority comes from seller binding and from grants.

**Errors** follow WBA: HTTP status and headers. Any AdCP error body is the generic authentication error.

**Scope.** In 3.3 the profile covers HTTP requests and webhooks. JWS document signing moves in 3.4.

**The 3.2 profile** (brand.json, `identity.brand_json_url`, `jwks_uri`) is deprecated in 3.3. It stays fully functional through 3.x and is removed in 4.0. This decision supersedes `adcp-agent-url` (#7817) and the client-only bootstrap (#7942).

## Rationale

The 3.2 discovery chain starts by calling the signer, so every signing buyer must run a capabilities endpoint. It also gives a seller no way to identify a signer it has not onboarded.

Taking identity from the origin collapses key discovery to one fetch. Because one agent occupies one origin, and the registrable-domain owner controls every origin under it, the operator record can be derived instead of pointed to. That removes both the capabilities dependency and the ambiguity of several records listing one agent.

Web Bot Auth is the IETF-adopted mechanism for exactly this header, directory, and fetch model. Using it as written means any conforming WBA library can sign for AdCP, and it avoids an AdCP-only header that 4.0 would retire.

The 3.2 profile is deprecated now because `versioning.mdx` requires 6 months' notice before a removal. The accepted trust.json plan already removes the 3.2 key chain in 4.0.

## Implications

The design spec is `specs/agent-identity-3-3.md`. It defines the rules (R0–R8), the threat-model deltas, and the P1–P9 implementation plan. The decision is taken at the WG working session on 2026-10-12 (decision brief on #7878); PR #8119 then records it.

**This record settles:**
- origin identity;
- derived trust records, evaluated off the signature path;
- that verification alone grants no authority;
- the WBA error contract;
- the deprecation of the 3.2 profile in 3.3, with removal in 4.0.

**This record does not settle:**
- JWS document signing and governance-key provenance (3.4);
- transparency logs;
- demand-side grants (#6033), onboarding posture (#8113, #8114), and relationship status, which are features of their own that the self-onboarding flow builds on.
