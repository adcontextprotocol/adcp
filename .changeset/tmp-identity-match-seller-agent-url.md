---
"adcontextprotocol": minor
---

TMP Identity Match: add required `seller_agent_url` to the request and make
`package_ids` optional.

**Why.** The buyer's identity-match service already keeps the authoritative
set of active packages it has registered per seller. Carrying that set on
every request was redundant and forced publishers to enumerate ALL active
packages on every call to avoid the set-correlation attack on Context
Match. Identifying the seller by URL lets the buyer resolve the package
set itself.

**Changes to `static/schemas/source/tmp/identity-match-request.json`.**

- New required field `seller_agent_url` (`string`, `format: uri`). The
  seller agent's API endpoint URL. Compared using the AdCP URL
  canonicalization rules, consistent with `seller_agent.agent_url` on
  `AvailablePackage` and `agent_url` in `adagents.json`.
- `package_ids` is now optional. When omitted, the buyer evaluates against
  the full active set registered for `seller_agent_url`. When provided,
  the ALL-active-packages rule still applies — partial sets remain a
  correlation risk.
- Top-level description updated to reflect both modes.

**Spec changes alongside the schema.**

- Reversed prior stance forbidding seller identity on `identity_match_request`. The "What This Is Not" / SellerAgentRef guidance has been narrowed to apply only to `context_match_request`.
- Added a fail-closed rule: when `seller_agent_url` matches no seller for which the buyer has registered active packages, the buyer MUST return an empty `eligible_package_ids`, not fall back to another seller's set.
- Defined precedence when both `seller_agent_url` and `package_ids` are present: buyer evaluates against the intersection of its registered active set and `package_ids`; unknown IDs are silently dropped (not error-surfaced) so the response cannot leak registry membership.
- Reframed the package-set-decorrelation invariant as **statistical independence of `package_ids` from the current placement**, with two acceptable modes: all-active and fuzzed (random sample padded with synthetic non-existent IDs that the buyer silently drops). The page-specific subset remains forbidden.
- Strengthened temporal decorrelation: random delay alone leaks the pairing through ordering. Publishers SHOULD also randomize whether Context Match or Identity Match is sent first — each opportunity SHOULD have a roughly equal probability either way.

**Privacy boundary.** `seller_agent_url` identifies the seller agent, not
the user; no leakage across the identity boundary. Routers do NOT strip
it (unlike `country`) — buyers need it to resolve the package set.

**Backwards compatibility.** Breaking for the experimental TMP schema
(`x-status: experimental`): callers MUST now send `seller_agent_url`. The
relaxation of `package_ids` is non-breaking on its own — previously valid
requests remain valid as long as they also include `seller_agent_url`.
