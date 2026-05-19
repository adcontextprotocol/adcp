---
"adcontextprotocol": patch
---

IdentityMatch & frequency capping architecture, with the wire-spec change and the data-flow boundary contract landing as authoritative protocol docs. Counting and policy live in the buyer's impression tracker; the IdentityMatch service consumes only cap-fire events at the boundary.

**Wire spec changes** (`identity-match-response.json`):
- Adds `serve_window_sec` (integer, 1–300, default 60) — per-package single-shot fcap window. After serving the user one impression on each eligible package within this window, the publisher MUST re-query Identity Match before serving from those packages again. Not a router response cache TTL.
- Removes `ttl_sec`. Originally documented as a router cache TTL but operationally functioned as a per-package serve throttle. TMP is pre-launch (experimental, pre-3.0.0 GA) and not subject to deprecation cycles, so the field is removed outright.

**Doc updates:**
- `docs/trusted-match/specification.mdx` — adds `serve_window_sec` field, removes `ttl_sec`, adds normative conformance invariants for IdentityMatch eligibility (audience intersection; cap-state presence check; active state; audience freshness). Updates the caching section for the new contract.
- `docs/trusted-match/identity-match-implementation.mdx` (new page) — frequency-cap data flow (boundary contract): the cap-fire event the impression tracker writes into the IdentityMatch cap-state store, and how the IdentityMatch service consumes it at query time. The protocol does not constrain how the impression tracker counts impressions, evaluates windows, or decides when a cap fires — those concerns live entirely in the buyer's impression-tracking pipeline.
- `docs/trusted-match/buyer-guide.mdx` — updates frequency-cap management to reflect the impression-tracker / IdentityMatch split, and the serve-window contract section.
- `docs/trusted-match/migration-from-axe.mdx` — adds OpenRTB 2.6 `User.eids[]` cross-walk for buyers bridging from OpenRTB-shaped pipelines.

**Three-layer model:**
- Wire spec (normative) — what crosses an agent boundary.
- Conformance invariants (normative) — backend-agnostic eligibility logic, including a presence check against cap-state.
- Boundary contract (normative for the cap-state store API) — what events flow from the impression tracker into the IdentityMatch cap-state store. Storage backend is implementer choice; the reference store ships in `adcp-go/targeting/fcap` (Valkey 9 hashes with HSETEX).

**Cap-state store surface:** `RecordCap(userIdentity, fields, expireAt)` and `IsCapped(userIdentity, field)`, where `field` is `{seller_agent_url, package_id}`. v1 keys cap-state at `(user_identity, seller_agent_url, package_id)`; broader-dimension caps (advertiser, campaign, creative, line item) are a future extension to the boundary contract.

**Architecture history** preserved at `specs/identitymatch-fcap-architecture.md` — captures design decisions, deferred security/privacy follow-ups, the rollout plan, and consolidated Slack/PR-review threads. Earlier iterations of the design (counter-based exposure tracking, log-based tracking with `impression_id` dedup, `fcap_keys` label model) were unwound — counting, dedup, and policy evaluation depend on buyer-internal concerns the protocol shouldn't constrain.

All TMP surfaces remain `x-status: experimental`. Per the experimental-status contract, fields on this surface are not subject to deprecation cycles until 3.0.0 GA.

**Tracked deferred follow-ups** (not in this PR):
- TMPX harvest → competitor-suppression attack
- Eligibility-as-audience-membership oracle (honeypot package_ids)
- Consent revocation between IdentityMatch and impression
- Side-channel via eligibility deltas
- `hashed_email` in TMPX leak surface
- DoS amplification via large `package_ids[]`
- Cap-state extensions for advertiser/campaign/creative dimensions
- Identity-graph plug-point in the impression tracker
