---
"adcontextprotocol": patch
---

**URL canonicalization: one authoritative reference for every URL-as-identifier comparison in AdCP.**

The canonicalization algorithm previously lived only under the request-signing profile in `docs/building/implementation/security.mdx`, but AdCP compares URLs as identifiers in many other places — TMP seller authorization (`seller_agent.agent_url` vs `authorized_agents[].url`), TMP provider resolution (`ProviderEntry.agent_url`), `format-id.agent_url` equivalence, and signal/feature agent lookups in `adagents.json`. Schemas today said "exactly as declared," which reads as byte-equality; two URLs that differ only in case, default port, or percent-encoded unreserved characters would silently miss the match.

This change moves the algorithm to a first-class reference page and links every consuming surface to it, so the same canonicalization binds everywhere.

- **New `docs/reference/url-canonicalization.mdx`** — the authoritative home of the 8-step algorithm (RFC 3986 §6.2.2 + §6.2.3, UTS-46 Nontransitional IDN pin, IPv6 zone-identifier rejection, enumerated malformed-authority cases), a "where it applies" table covering signing / TMP seller authorization / TMP provider resolution / `adagents.json` lookups / `format-id` / `authoritative_location` indirection, a "signing profile extensions" note for the transport-only bits, and a common-pitfalls list.
- **`docs/building/implementation/security.mdx`** — `@target-uri` section now cites the reference page instead of restating the eight steps. Keeps only the signing-specific extensions (HTTP/2 `:authority` derivation, dual-header rejection, `request_target_uri_malformed` error, cross-vhost replay gate). Removes the drift risk between two copies.
- **`static/schemas/source/core/seller-agent-ref.json`** — `agent_url` description replaces "exactly as declared" with canonicalization-based comparison. Also drops the "in production" weasel on HTTPS — the scheme requirement is now unconditional.
- **`static/schemas/source/adagents.json`** — all six `url` descriptions updated: the four `authorized_agents[].url` variants, plus the two signals-authorization variants (`signal_ids`, `signal_tags`) and the property-features variant.
- **`static/schemas/source/core/format-id.json`** — `agent_url` description updated to require canonicalization.
- **`static/schemas/source/tmp/provider-registration.json`** — `endpoint` description extends the existing SSRF/DNS-rebinding language with a canonicalization rule for provider-registry de-duplication.
- **`docs/trusted-match/specification.mdx`** — TMP Sync-Time Validation step 2 links canonicalization rules explicitly and adds an explicit `https://`-only rejection (non-HTTPS seller URLs get `seller_not_authorized`, closing the scheme-mismatch bypass). ProviderEntry table row links the canonicalization rules for provider comparison.
- **`docs.json`** — reference page added to both primary and legacy sidebars adjacent to `versioning` (other interop-rules references).

No schema shape changes. Descriptions only. Schema link style follows the repo convention (`See docs/<path>` bare, no backticks or leading slash).
