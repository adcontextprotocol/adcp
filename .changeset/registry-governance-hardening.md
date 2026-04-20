---
---

spec(registry+governance): R-2 `signing_keys` pin, R-4 advisory-feed-identity flag, R-5 anti-homograph save-time controls

Three registry/governance hardening items, split out of the closed red-team batch-2 PR (#2466):

- **R-2 (`adagents.mdx`)** — require `signing_keys` for agents with mutating scope (enumerated against 3.x task catalog); normative verifier rule that the publisher's pinned keys MUST take precedence over an agent-hosted JWKS when the pin exists; adds key-rotation / cache-TTL / overlap-window guidance and explicit bootstrap scope (pin protects agent-domain compromise, not publisher-domain).
- **R-4 (`registry-change-feed.md`)** — Change Feed events are a change-detection optimization, not a trust anchor: any `signing_keys` carried inline are explicitly advisory; verifiers MUST re-fetch the authoritative artifact and verify against the publisher pin before acting on identity changes, MAY coalesce re-fetches per `(publisher, artifact)` within the publisher's cache TTL to avoid thundering-herd. Sketches feed-event content signing as 4.0 R-1 follow-up.
- **R-5 (`registry/index.mdx`)** — add §Anti-abuse and anti-homograph controls documenting IDNA 2008 normalization + confusable detection (including a curated high-value-brand deny list), MUST ownership-proof before committing a new community-source entry with single-use 15-minute nonce semantics (SHOULD re-prove on rolling 90-day basis for revisions), and per-organization save rate limits as the hosted registry's save-time floor.

Docs-only. No schema change.
