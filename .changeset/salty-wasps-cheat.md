---
---

AAO Verified agent badge — implementation. Agents that declare `specialisms` in `get_adcp_capabilities` and pass the matching storyboards earn a per-protocol badge. Implements the trust-mark spec from #3001 (which introduced `AdCP Conformant` and `AAO Verified` as separate marks) under a single brand name with composable axis qualifiers — `AAO Verified Media Buy Agent (Spec)`, `(Live)`, or `(Spec + Live)`. Same containment relationship as #3001 (Spec is a prerequisite for measuring Live); single brand word for cleaner buyer messaging.

Badges are issued by AAO's compliance heartbeat to agents whose organization holds an active API-access membership tier, and revoked when membership lapses or specialisms start failing (48-hour grace). Preview-status specialisms are tested but do not contribute to stable badge issuance.

The badge surface:

- Shields.io-style SVG at `/api/registry/agents/{url}/badge/{role}.svg` with the qualifier rendered inline (`Media Buy Agent (Spec)` etc.). Unknown modes from corrupted DB rows are filtered out at render time so the public mark can never carry text outside the known set. WCAG AA contrast, XSS-safe escaping, CSP headers.
- Embed-code endpoint returning HTML and Markdown snippets that link back to the agent's registry listing.
- Ed25519-signed JWT tokens for decentralized verification; public key served at `/.well-known/jwks.json`. Token claim `verification_modes: VerificationMode[]` is the wire-format contract for axis-of-verification — `["spec"]` today, `["spec", "live"]` once the canonical-campaign runner ships. Filtered against the known set both at signing and at verification; tokens with unknown or missing modes are rejected.
- brand.json enrichment — when AAO serves brand.json, agent entries get an `aao_verification` block including per-role `modes_by_role`.
- Registry API responses include `verified_badges[]` with `verification_modes` per badge.
- `verification_earned` / `verification_lost` notifications via Slack, DMs, and the catalog change feed.
- DB column `agent_verification_badges.verification_modes TEXT[]` constrained to `<@ ARRAY['spec', 'live']` with non-empty enforcement at the schema level.
- New `docs/building/aao-verified.mdx` covering the orthogonal-axes framing, lifecycle, embed surfaces, and the conformance/verification distinction; cross-linked from `conformance.mdx`.

Wire format design notes: the `verification_modes` array is the only forward-compatible point — adding `'live'` later will not change badge URLs, JWT structure, or registry response shapes. Embedded badges automatically render `(Spec + Live)` the moment a canonical campaign comes online for an agent.
