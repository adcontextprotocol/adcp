---
"adcontextprotocol": minor
---

Define one agent-resolution algorithm in `security.mdx`, still backed by brand.json, and make every signing surface cite it. These surfaces are request signing, webhook signing, governance JWS `iss`, designated-task response signing, rights attestations, and TMP. The algorithm has four parts:

- **Which brand.json lists the agent.** A verifier uses the agent's operator record from `identity.brand_json_url`, or a record the verifier already trusts. Examples of the second case are the buyer's brand.json for governance and the `brand_domain` brand.json for brand claims.
- **Matching.** Agent URLs are matched by canonical URL on every surface. Webhook discovery and governance `iss` no longer compare byte-for-byte, and the capabilities `verifier_constraints.agent_url_match` is now `canonical`.
- **Publisher pin.** A publisher's adagents.json `signing_keys` pin now narrows the accepted keys as an intersection with the agent's JWKS, for sell-side signatures about that publisher's inventory. A pin never adds a key, and the `key_origins` check always applies.
- **Shortcuts.** Cached or onboarding mappings must be confirmed against the agent's `brand_json_url`.

Webhook discovery now starts from `identity.brand_json_url`, with a 3.x fallback to the agent host's brand.json for sellers that omit it. The `authorized_operators` origin-binding fallback reads only from House Portfolio documents. Governance "adagents-style agent registry" wording is replaced with the agent-resolution path.
