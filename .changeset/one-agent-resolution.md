---
"adcontextprotocol": minor
---

Define one agent-resolution algorithm in `security.mdx`, still backed by brand.json, and make every signing surface cite it. These surfaces are request signing, webhook signing, governance JWS `iss`, designated-task response signing, and rights attestations. TMP keeps its own publisher-key model. The algorithm has four parts:

- **Which brand.json lists the agent.** A verifier uses the agent's operator record from `identity.brand_json_url`, or a record the verifier already trusts. Examples of the second case are the buyer's brand.json for governance and the `brand_domain` brand.json for brand claims. A House Portfolio operator record matches across `house.agents[]` and every `brands[].agents[]`, counting entries that agree on type and JWKS source once. Governance picks its agent collection the same way as the brand-claim cross-check.
- **Matching.** Agent URLs are matched by canonical URL on every surface. Webhook discovery and governance `iss` no longer compare byte-for-byte, and the capabilities `verifier_constraints.agent_url_match` is now `canonical`.
- **Publisher pin.** A publisher's adagents.json `signing_keys` pin now narrows the accepted keys for sell-side signatures about that publisher's inventory. A key must be in the agent's JWKS and match a pinned entry by RFC 7638 thumbprint. Matching by `kid` alone is not enough, and a pinned entry without key material matches nothing. Verifiers take the applicable publishers from their own record of the media buy, never from the payload.
- **Shortcuts.** Cached or onboarding mappings must be confirmed against the agent's `brand_json_url` and refreshed within the brand.json cache lifetime.

Webhook discovery now starts from `identity.brand_json_url` and runs the `key_origins` check for every webhook. A 3.x fallback reads the brand.json at the agent's host or eTLD+1 for sellers that omit the field. The `authorized_operators` origin-binding fallback reads only from House Portfolio documents. Governance buyer identity for signed requests is the exact operator record that agent resolution selected.

**Migration.** Some signatures that verified before can now fail:
- A pinned key that the agent's JWKS does not publish is rejected. Operators must publish every pinned key in the agent's JWKS.
- A pin entry with only a `kid` matches nothing.
- `key_origins` is now checked for every webhook signer that publishes `brand_json_url`, including pinned keys.
- Two `agents[]` entries that differ only in a way canonicalization ignores, such as host case or a default port, are now an ambiguous match.
