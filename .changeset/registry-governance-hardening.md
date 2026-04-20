---
---

spec(registry+governance): R-2 `signing_keys` pin, R-4 advisory-feed-identity flag, R-5 anti-homograph save-time controls

Three registry/governance hardening items, split out of the closed red-team batch-2 PR (#2466):

- **R-2 (`adagents.mdx`)** — require `signing_keys` for agents with mutating scope; normative verifier rule that the publisher's pinned keys MUST take precedence over an agent-hosted JWKS when the pin exists.
- **R-4 (`registry-change-feed.md`)** — Change Feed events are a change-detection optimization, not a trust anchor: any `signing_keys` carried inline are explicitly advisory; verifiers MUST re-fetch the authoritative artifact and verify against the publisher pin before acting on identity changes. Sketches feed-event content signing as 4.0 follow-up.
- **R-5 (`registry/index.mdx`)** — add §Anti-abuse and anti-homograph controls documenting IDNA 2008 normalization + confusable detection, ownership-proof before commit, and per-organization save rate limits as the hosted AgenticAdvertising.org registry's save-time floor.

Docs-only. No schema change.
