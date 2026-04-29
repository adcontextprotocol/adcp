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

**Spec change.** `docs/trusted-match/specification.mdx` previously stated
that seller identity MUST NOT appear in `identity_match_request` and that
`package_ids` was the only scoping mechanism. That stance is reversed for
Identity Match: the buyer needs the seller's URL to resolve its registered
package set. The corresponding "What This Is Not" / SellerAgentRef
guidance has been narrowed to apply only to `context_match_request`.

**Privacy boundary.** `seller_agent_url` identifies the seller agent, not
the user; no leakage across the identity boundary. Routers do NOT strip
it (unlike `country`) — buyers need it to resolve the package set.

**Backwards compatibility.** Breaking for the experimental TMP schema
(`x-status: experimental`): callers MUST now send `seller_agent_url`. The
relaxation of `package_ids` is non-breaking on its own — previously valid
requests remain valid as long as they also include `seller_agent_url`.
