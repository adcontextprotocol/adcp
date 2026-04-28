---
"adcontextprotocol": patch
---

IdentityMatch & frequency capping architecture, with both the wire-spec change and the implementation guidance landing as authoritative protocol docs.

**Wire spec changes** (`identity-match-response.json`):
- Adds `serve_window_sec` (integer, 1–300, default 60) — per-package single-shot fcap window. After serving the user one impression on each eligible package within this window, the publisher MUST re-query Identity Match before serving from those packages again. Not a router response cache TTL.
- Deprecates `ttl_sec`. Originally documented as a router cache TTL but operationally functioned as a per-package serve throttle. Senders during the deprecation window populate both fields; receivers prefer `serve_window_sec`. Removed in a 3.0.x release ≥ 6 weeks after the 2026-04-26 notice (earliest 2026-06-07).

**Doc updates** (authoritative implementation guidance):
- `docs/trusted-match/specification.mdx` — adds `serve_window_sec` field, marks `ttl_sec` deprecated, adds normative conformance invariants for IdentityMatch eligibility (audience intersection, fcap merge across identities, active state, audience freshness). Updates the caching section for the new contract.
- `docs/trusted-match/identity-match-implementation.mdx` (new page) — implementation guide covering the `fcap_keys` label model with tenant prefix and charset, reference valkey-backed data model (audience SET, exposure HASH, package HASH, fcap_policy HASH), merge rules with MAX recommended, SDK primitives (`decodeTmpx`, `writeExposure`, `upsertAudience`, `upsertPackage`, `upsertFcapPolicy`, `inspectExposure`), pluggable store interfaces (FrequencyStore / AudienceStore / PackageStore / FcapPolicyStore), production topology pattern (pub/sub buffering between tracking endpoint and store writer), and Redis-command walkthroughs for the five conformance scenarios.
- `docs/trusted-match/buyer-guide.mdx` — updates frequency-cap management and the serve-window contract sections; cross-links to the implementation page.
- `docs/trusted-match/migration-from-axe.mdx` — adds OpenRTB 2.6 `User.eids[]` cross-walk for buyers bridging from OpenRTB-shaped pipelines.

**Three-layer model:**
- Wire spec (normative) — what crosses an agent boundary.
- Conformance invariants (normative) — backend-agnostic eligibility logic.
- Reference data model (non-normative) — Scope3's valkey-backed implementation choice. Buyers may use Aerospike, DynamoDB, or anything else; the SDK exposes pluggable store interfaces. The protocol describes WHAT the service must compute, not HOW it stores the data.

**SDK primitives** ship across `@adcp/client` (TS), `adcp-go`, and `adcp` (Python). Same primitive surface in all three languages. Impression handling is two composable functions (`decodeTmpx` + `writeExposure`), not one bundled call — production tracking endpoints decode at intake and write downstream behind a pub/sub buffer; bundling would force synchronous topology.

**Architecture history** preserved at `specs/identitymatch-fcap-architecture.md` (slimmed from 485 to 136 lines) — captures the design decisions, the deferred security/privacy follow-ups, the rollout plan, and consolidated Slack/PR-review threads. Implementation details now live in `docs/`.

All TMP surfaces remain `x-status: experimental`. Wire change is purely additive (`serve_window_sec`); the `ttl_sec` removal lands in a later 3.0.x.

**Tracked deferred follow-ups** (not in this PR):
- TMPX harvest → competitor-suppression attack
- Eligibility-as-audience-membership oracle (honeypot package_ids)
- Consent revocation between IdentityMatch and impression
- Side-channel via eligibility deltas
- `hashed_email` in TMPX leak surface
- DoS amplification via large `package_ids[]`
- Where do fcap policies live on the wire (currently SDK-only)
- Identity-graph plug-point interface for SDK
