---
---

AAO Verified agent badge system. Agents that declare `specialisms` in `get_adcp_capabilities` and pass the matching storyboards earn a per-protocol badge (e.g. "AAO Verified Media Buy Agent"). Badges are issued by AAO's compliance heartbeat to agents whose organization holds an active API-access membership tier, and revoked automatically when membership lapses or specialisms start failing (48-hour grace). Preview-status specialisms are tested but do not contribute to stable badge issuance.

The badge surface:
- Shields.io-style SVG at `/api/registry/agents/{url}/badge/{role}.svg` with WCAG AA contrast, XSS-safe escaping, and CSP headers
- Embed-code endpoint returning HTML and Markdown snippets that link back to the agent's registry listing
- Ed25519-signed JWT tokens for decentralized verification; public key served at `/.well-known/jwks.json`
- brand.json enrichment — AAO appends `aao_verification` to agent entries when serving resolved brand data
- Registry API responses include `verified_roles[]` and per-role badge metadata
- `verification_earned` / `verification_lost` notifications via Slack, DMs, and the catalog change feed
- New `docs/building/aao-verified.mdx` covering issuance, lifecycle, and the conformance/verification distinction
