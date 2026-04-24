---
"adcontextprotocol": patch
---

**URL canonicalization: lift the rules out of the signing profile as a
general AdCP reference.**

The canonicalization algorithm used for request-signing's `@target-uri`
is the same algorithm AdCP needs everywhere URLs are compared as
identifiers — TMP seller authorization (`seller_agent.agent_url` vs
`authorized_agents[].url`), `adagents.json` authorization lookups,
`format-id.agent_url` equivalence, and any future URL-keyed registry.
Schemas today said "exactly as declared," which invites byte-equality
comparison; two URLs that differ only in case, default port, or
percent-encoded unreserved characters would miss the match.

- **New `docs/reference/url-canonicalization.mdx`** — canonical
  reference lifting the RFC 3986 §6.2.2 + §6.2.3 rules out of the
  signing-specific section. Covers the 8 normalization steps, IPv6
  zone-identifier rejection, the UTS-46 Nontransitional IDN pin, and
  a "where it applies" table with links to each consuming surface.
  Points to the existing conformance vectors at
  `/compliance/latest/test-vectors/request-signing/canonicalization.json`.
- **`static/schemas/source/core/seller-agent-ref.json`** — `agent_url`
  description now says comparison uses the canonicalization rules
  (not byte-equality) and links to the reference page.
- **`static/schemas/source/adagents.json`** — all four
  `authorized_agents[].url` descriptions (across the `property_ids`,
  `brand_ids`, and signal-authorization variants) updated to require
  canonicalization-based comparison.
- **`static/schemas/source/core/format-id.json`** — `agent_url`
  description updated to require canonicalization before treating two
  formats as the same.
- **`docs/trusted-match/specification.mdx`** — TMP Sync-Time
  Validation step 2 now links the canonicalization rules explicitly
  instead of leaving implementers to infer byte-equality.
- **`docs/building/implementation/security.mdx`** — `@target-uri`
  canonicalization section adds a forward-reference to the general
  page so the signing profile and the general rules cross-link both
  ways.
- **`docs.json`** — page added to the Reference nav (both primary and
  legacy sidebars).

No schema shape changes — descriptions only. The reference page does
not redefine the algorithm; it confirms that the same algorithm
governs every URL-as-identifier comparison in AdCP and tells readers
where to find the authoritative detail and conformance vectors.
