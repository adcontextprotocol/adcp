# IdentityMatch & Frequency Capping — Architecture Spec

**Status**: landed (architecture decisions).
**Target release**: 3.0.1 (additive wire change).

This spec captures the architecture decisions behind the buyer-side IdentityMatch surface in TMP. It is a **design-history document**, not an implementation reference — the authoritative spec lives in:

- [`docs/trusted-match/specification.mdx`](../docs/trusted-match/specification.mdx) — wire spec (normative): `serve_window_sec` field, conformance invariants for IdentityMatch eligibility, TMPX binary format.
- [`docs/trusted-match/identity-match-implementation.mdx`](../docs/trusted-match/identity-match-implementation.mdx) — frequency-cap data flow (boundary contract): the cap-fire event the impression tracker writes into the IdentityMatch cap-state store, and how the IdentityMatch service consumes it at query time. Internal counting / policy / storage layout are buyer-internal and out of scope.
- [`docs/trusted-match/buyer-guide.mdx`](../docs/trusted-match/buyer-guide.mdx) — buyer-agent integration walkthrough; updated for `serve_window_sec` semantic.
- [`docs/trusted-match/migration-from-axe.mdx`](../docs/trusted-match/migration-from-axe.mdx) — adds OpenRTB 2.6 `User.eids` cross-walk for buyers bridging from OpenRTB-shaped pipelines.

Read this doc when you want to understand **why** the design landed where it did. Read the docs above when you want to **implement** against it.

## Problem

The TMP IdentityMatch wire spec defines what flows on the wire: identity tokens in, eligible package IDs and an HPKE-encrypted exposure token (`tmpx`) out. It did not previously define:

1. **Where fcap policy and counting live.** Originally implied to be inside the IdentityMatch service. Settled here as buyer-internal in the impression tracker; the IdentityMatch service consumes only cap-fire events at the boundary.
2. **Boundary contract between impression tracker and IdentityMatch service** — what events flow from the impression-tracking pipeline into the IdentityMatch cap-state store.
3. **Audience freshness vs. response throttle** — `ttl_sec` was documented as a router cache TTL but operationally functioned as a per-package serve throttle, conflating two distinct concerns.
4. **Conformance** — how a third party validates that an IdentityMatch implementation is correct.

Without these decisions, the open-source IdentityMatch reference impl risked shipping with Go-shaped assumptions baked into wire-adjacent surfaces, or with policy logic baked into the service that should sit in the buyer's impression-tracking pipeline.

## Architectural decisions

### 1. Three layers, with explicit normative status

| Layer | Status | What it covers |
|---|---|---|
| **Wire spec** | Normative | HTTP JSON, `serve_window_sec` semantic, TMPX binary format. Anything crossing an agent boundary. |
| **Conformance invariants** | Normative | The eligibility logic an IdentityMatch service MUST compute, expressed in terms of inputs (identities, packages, audiences, cap-state) and outputs (eligible_package_ids). Storage-agnostic. |
| **Boundary contract for cap-fire events** | Normative for the cap-state store API | What events flow from the impression tracker into the IdentityMatch cap-state store, and what state IdentityMatch consumes at query time. The store interface (e.g. `RecordCap` / `IsCapped` in `adcp-go/targeting/fcap`) is the reference shape. Storage backend is implementer choice. |

The protocol describes **what** the service must compute and **what** events flow into it, not how the impression tracker counts impressions or where its policy state lives.

### 2. Counting and policy live in the impression tracker, not in IdentityMatch

The IdentityMatch service does not count impressions. It does not own fcap policies. It does not evaluate windows. Those concerns live entirely in the buyer's impression-tracking pipeline, where they vary across buyers and across campaigns.

The IdentityMatch service maintains a narrow **cap-state store** keyed at `(user_identity, seller_agent_url, package_id)` with a TTL-bound expiration. The impression tracker writes a cap-fire entry on the impression that exhausts a cap; the IdentityMatch service checks presence at query time and excludes the package from `eligible_package_ids` while the entry is live.

This split keeps the IdentityMatch service narrow and makes new cap dimensions (advertiser, campaign, creative, line item — see [Future extensions](#future-extensions)) extensions of the boundary contract rather than rewrites of the service. Earlier iterations of this design proposed an exposure-log model inside the IdentityMatch service, with cross-identity dedup via `impression_id`, label-model fcap keys, and the IdentityMatch service evaluating windows at read time. That design was unwound — counting, dedup, and policy evaluation all depend on buyer-internal concerns the protocol shouldn't constrain. The reference store in [`adcp-go/targeting/fcap`](https://github.com/adcontextprotocol/adcp-go/tree/main/targeting/fcap) implements the simpler boundary contract.

### 3. Cross-identity dedup is a buyer-internal concern

A single impression resolved to multiple identity tokens may produce multiple cap-fire entries — one per `(identity, package)` pair the cap fired on — but how the impression tracker decides "this is one impression vs. three" is buyer-internal. Buyers running their own identity graph can canonicalize before counting; buyers that don't get whatever counting their impression tracker is configured to do. The protocol does not require an `impression_id` and does not constrain dedup logic.

### 4. `serve_window_sec` replaces `ttl_sec`

The original `ttl_sec` field was documented as a router cache TTL but operationally functioned as a per-package single-shot fcap. Two distinct concerns sharing one knob meant tuning for cost (long cache) silently broke fcap, and tuning for fcap (short cache) wasted IdentityMatch round-trips.

Replacement: `serve_window_sec` (1–300, default 60) with the corrected semantic — *after serving the user one impression on each eligible package within this window, the publisher MUST re-query Identity Match before serving from those packages again.*

`ttl_sec` is removed. No deprecation window: TMP is pre-launch (experimental, pre-3.0.0 GA) and not subject to deprecation cycles. The field is not present in the 3.0.1 schema.

### 5. Cap-fire events as the impression-handling primitive

The impression tracker decodes TMPX, applies the buyer's policy logic, and (when a cap fires) writes a cap-fire entry to the IdentityMatch cap-state store. The cap-state store API ([`adcp-go/targeting/fcap`](https://github.com/adcontextprotocol/adcp-go/tree/main/targeting/fcap)) exposes:

```
RecordCap(ctx, userIdentity, fields[]Field, expireAt)  // write cap-fire
IsCapped(ctx,   userIdentity, field Field) (bool)      // query cap-state
```

— plus batch variants. `Field` is `{SellerAgentURL, PackageID}`. Production deployments separate decode (synchronous, at intake) from policy evaluation and cap-state writes (asynchronous, behind a queue) for buffering — bundling would force synchronous topology and break the pattern.

### 6. TMP IdentityMatch service is a downstream consumer of cap-state

The IdentityMatch service reads cap-state on each `/identity` call. Writes come from the impression tracker (or a downstream service in its pipeline) on cap-fire. No new wire endpoints for impressions or policies. The IdentityMatch service stays narrow.

### 7. Policy updates trigger cap-state re-evaluation at the buyer

Cap-state entries are written under whatever fcap policy was in force at cap-fire time. When policies change (window length, `max_count`, activation, package reassignment), the buyer's policy owner MUST re-evaluate every affected `(user_identity, package)` entry against the new policy and push delete-or-extend events to the cap-state store. The cap-state store carries no counts and can't re-evaluate on its own — the buyer's counting state is the source of truth. The protocol does not constrain re-evaluation cadence; only that cap-state must converge to what the current policies imply. See [docs/trusted-match/identity-match-implementation.mdx § Policy updates and cap-state re-evaluation](../docs/trusted-match/identity-match-implementation.mdx#policy-updates-and-cap-state-re-evaluation) for the event shapes.

### 8. `sync_audiences` is the audience on-ramp

The existing wire `sync_audiences` task has `add[]`/`remove[]` deltas of audience-member objects — exactly the CRUD shape the IdentityMatch backend needs for the audience side of eligibility. No schema extension required.

## Future extensions

Today the cap-state store is keyed at `(user_identity, seller_agent_url, package_id)`. Future protocol versions may extend the field to additional dimensions — advertiser, campaign, creative, line item — so a buyer can express caps that span multiple packages without writing N entries on every cap-fire. The boundary contract is unchanged by such extensions: the impression tracker writes cap-fire entries; the IdentityMatch service checks presence at query time.

## Open questions

1. **Cap-state extensions for advertiser/campaign/creative.** v1 keys at `(user_identity, seller_agent_url, package_id)`. Extending to broader cap dimensions without forcing the impression tracker to write N entries on each cap-fire is a follow-up workstream.
2. **Explicit delete primitive on the cap-state store.** The reference impl exposes `RecordCap` (write/extend) and `IsCapped` (presence) but no explicit delete. Re-evaluation today expresses "delete" as "extend with an `expire_at` already in the past." A first-class `DeleteCap` operation is a candidate primitive, especially as policy-change re-evaluation becomes a hot path.
3. **Identity-graph plug-point.** Whether the impression tracker canonicalizes identities before writing cap-state, or writes per-resolved-identity, is buyer-internal. The protocol does not require the IdentityMatch service to know about identity graphs.
4. **Audience strength scores.** Per-segment scores are an open extension on the audience side of eligibility, separate from cap-state.
5. **Production-deployment perf benchmarks.** Cap-state lookups are hash-field presence checks (HEXISTS), but real-world latency depends on backend choice, network co-location, and cluster sharding under load. Tracked as a rollout-plan deliverable.

## Deferred security & privacy issues (follow-up)

These came out of pre-merge review. Each warrants a focused follow-up rather than blocking this design landing.

1. **TMPX harvest → competitor-suppression attack.** TMPX in publisher creative URLs is harvestable. Without per-impression binding (creative_id, slot_id, ts) inside the AEAD AAD, an attacker fires harvested tokens at the buyer's impression endpoint to drive cap-fire signals and starve a target user out of a campaign. Mitigation: bind TMPX to per-impression context, or rate-limit-per-token at the impression handler.
2. **Eligibility-as-audience-membership oracle.** A malicious publisher submits honeypot `package_ids` and observes which return eligible to reconstruct the user's audience profile. The "publishers don't see audience records" privacy claim is wire-correct but functionally false. Mitigation: package-ownership check at IdentityMatch ingress, or k-anonymity floor on eligibility responses.
3. **Consent revocation between IdentityMatch and impression.** TMPX has no consent fingerprint; if consent is revoked during the serve window, the impression tracker may still process the exposure. GDPR/TCF problem.
4. **Side-channel via eligibility deltas.** A router observing two responses for the same user 30s apart sees `eligible_package_ids` shrink as caps trip — fingerprinting fcap state per-user.
5. **`hashed_email` in TMPX widens identity-leak surface.** Putting unsalted SHA-256 email inside a creative URL macro re-identifies on token leak. Either prohibit `hashed_email` in TMPX plaintext or require salting.
6. **DoS amplification via large `package_ids[]`.** Per-IdentityMatch cap-state reads scale `O(|identities| × |candidate_packages|)` — at 25k packages from a busy publisher, this is an amplification primitive. Cap candidate_packages at IdentityMatch ingress.
7. **Rollout work plan ownership gaps.** No named owner for the eligibility-evaluator hot path, observability/SLO, key-rotation drill, or load testing. Address before SDK ships.

## Rollout plan

### What this PR landed

- Wire spec change (additive): `serve_window_sec` field on `identity-match-response.json`. `ttl_sec` removed (pre-launch, no deprecation cycle needed).
- Doc updates to `docs/trusted-match/specification.mdx`, `buyer-guide.mdx`, `migration-from-axe.mdx`.
- New page: `docs/trusted-match/identity-match-implementation.mdx` — frequency-cap data flow (boundary contract).
- This architecture-rationale doc.

### Next workstreams (not in this PR)

1. **`adcp-go/targeting/fcap` cap-state store** — landed upstream as the reference cap-state store backed by Valkey 9 hashes (`fcap:{hash}` keys, one HSETEX field per `(seller_agent_url, package_id)`).
2. **`@adcp/client` (TS) and `adcp` (Python) parity** — same `RecordCap` / `IsCapped` boundary in TS and Python.
3. **`adcp-go/identitymatch` reference TMP server** — open-source read path for `POST /identity` over the cap-state store.
4. **Scope3 hosted IdentityMatch** — public deployment for buyers who don't want to host their own service.
5. **Training agent integration** — hosts both AdCP MCP/A2A and TMP `/identity` surfaces, sharing the cap-state store internally. End-to-end IdentityMatch demo.
6. **Conformance harness** — runner script that seeds cap-state directly, runs `/identity` queries against the TMP server, and asserts eligibility responses. Lives as integration tests inside `adcp-go` and `@adcp/client`.
7. **TMP graduation (target: 3.1.0)** — TMP enters `supported_protocols` (currently in `experimental_features` as `trusted_match.core`). At that point AdCP storyboards can wrap the harness if cross-protocol integration testing becomes useful.

## Threads consolidated from Slack 2026-04-26

- **Thread 1 (exposure struct location):** resolved by the three-layer model. Cross-language interop is at the cap-state store API level (`RecordCap` / `IsCapped`); no proto, no JSON Schema for buyer-internal records. TMPX wire format stays as published in `docs/trusted-match/specification.mdx`.
- **Thread 2 (campaign isn't AdCP):** resolved — cap dimensions live in the impression tracker, not in the wire protocol. v1 cap-state keys at `(user_identity, seller_agent_url, package_id)`. Seller agent + package_id remains the seller-side identifier per `core/seller-agent-ref.json`.
- **Thread 3 (campaign logic in IdentityMatch):** resolved — counting and policy live in the impression tracker; IdentityMatch consumes cap-fire events at the boundary.
- **Thread 4 (campaign sync via Cerberus):** resolved — cap-fire events are written directly to the cap-state store from the impression tracker; no Cerberus.

## Threads consolidated from Slack 2026-04-30 (impression handling)

Per discussion with @bhuo (Scope3 impression-tracker owner) and Brian:

- Production deployments separate decode at intake (synchronous) from policy evaluation and cap-state writes (asynchronous, behind a queue) for buffering. The cap-state store API exposes the write-side primitive (`RecordCap`); the impression tracker decides when to call it.
- "JS for writers, Go for reader" framing was wrong — Brian's "JS" was shorthand for "the language the impression tracker runs in," currently Go at Scope3. Spec/SDK is language-neutral; the cap-state API ships in `adcp-go`, with TS and Python parity tracked as a follow-up.
- Pub/sub buffering, retries, dedup, observability, abuse protection are deployment concerns, not protocol concerns. The cap-state store ships the boundary primitives; topology is the implementer's choice.

## Threads consolidated from PR #3359 review

- **@oleksandr's normative/reference layering question:** the original spec called the buyer-side valkey schema "normative" while leaving an open question for a pluggable FrequencyStore interface. Inconsistent. Resolved by the three-layer model — wire spec + conformance invariants are normative; cap-state store interface is the boundary contract; storage backend is implementer choice.
- **Counter-vs-log debate (Brian):** earlier iterations explored a counter-based exposure model and a log-based exposure-log model with `impression_id` dedup, both inside the IdentityMatch service. Both unwound — counting and dedup are buyer-internal concerns the protocol shouldn't constrain. The IdentityMatch service consumes cap-fire events; whatever counting the impression tracker does to decide "this is the cap-firing impression" is up to the buyer.
- **Cap dimensions:** earlier iterations debated how the protocol should express advertiser/campaign/creative caps (label model, hierarchy, etc.). Resolved — the protocol does not enumerate cap dimensions at all. The cap-state store v1 keys at `(user_identity, seller_agent_url, package_id)`; broader-dimension caps are a follow-up extension to the boundary contract.
