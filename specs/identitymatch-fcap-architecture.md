# IdentityMatch & Frequency Capping — Architecture Spec

**Status**: landed (architecture decisions). Implementation guidance promoted to `docs/trusted-match/`.
**Target release**: 3.0.1 (additive wire change), then deprecation removal in a 3.0.x ≥ 6 weeks after.
**Branch**: `bokelley/idmatch-design`
**PR**: [#3359](https://github.com/adcontextprotocol/adcp/pull/3359)

This spec captures the architecture decisions behind the buyer-side IdentityMatch surface in TMP. It is a **design-history document**, not an implementation reference — the authoritative implementation guidance lives in:

- [`docs/trusted-match/specification.mdx`](../docs/trusted-match/specification.mdx) — wire spec (normative): `serve_window_sec` field, `ttl_sec` deprecation, conformance invariants for IdentityMatch eligibility, TMPX binary format.
- [`docs/trusted-match/identity-match-implementation.mdx`](../docs/trusted-match/identity-match-implementation.mdx) — implementation guidance (non-normative): `fcap_keys` label model, reference valkey data model, merge rules, SDK primitives, pluggable store interfaces, production topology, conformance scenarios.
- [`docs/trusted-match/buyer-guide.mdx`](../docs/trusted-match/buyer-guide.mdx) — buyer-agent integration walkthrough; updated for `serve_window_sec` semantic.
- [`docs/trusted-match/migration-from-axe.mdx`](../docs/trusted-match/migration-from-axe.mdx) — adds OpenRTB 2.6 `User.eids` cross-walk for buyers bridging from OpenRTB-shaped pipelines.

Read this doc when you want to understand **why** the design landed where it did. Read the docs above when you want to **implement** against it.

## Problem

The TMP IdentityMatch wire spec defines what flows on the wire: identity tokens in, eligible package IDs and an HPKE-encrypted exposure token (`tmpx`) out. It did not previously define:

1. **Buyer-side data model** — what records the buyer maintains to compute eligibility (audiences, exposures, fcap policy), and how those records are keyed.
2. **Frequency-cap semantics** — what dimensions a cap can apply to (campaign, advertiser, group, …) and how multi-identity users are handled.
3. **Cross-language SDK scope** — what primitives ship across `@adcp/client`, `adcp-go`, and `adcp` (Python), and how HPKE key management slots into existing AdCP key plumbing.
4. **Audience freshness vs. response throttle** — `ttl_sec` was documented as a router cache TTL but operationally functioned as a per-package serve throttle, conflating two distinct concerns.
5. **Conformance** — how a third party validates that an IdentityMatch implementation is correct.

Without these decisions, the open-source IdentityMatch reference impl risked shipping with Go-shaped assumptions baked into wire-adjacent surfaces.

## Architectural decisions

### 1. Three layers, with explicit normative status

| Layer | Status | What it covers |
|---|---|---|
| **Wire spec** | Normative | HTTP JSON, `serve_window_sec` semantic, TMPX binary format. Anything crossing an agent boundary. |
| **Conformance invariants** | Normative | The eligibility logic an IdentityMatch service MUST compute, expressed in terms of inputs (identities, packages, audiences, policies, exposures) and outputs (eligible_package_ids). Storage-agnostic. |
| **Reference data model** | Non-normative | Scope3's valkey-backed implementation choice. Buyers running Aerospike, DynamoDB, or anything else are conformant if their service satisfies the invariants. |

The protocol describes **what** the service must compute, not **how** it stores the data. SDK exposes pluggable store interfaces; valkey is the reference connector.

### 2. `fcap_keys[]` as a label model, not hierarchy

`tenant:dimension:value` (e.g. `buyer-acme:campaign:42`, `buyer-acme:advertiser:13`). Tenant prefix required to prevent cross-tenant counter pollution in multi-tenant fleets. Charset constraint `[a-zA-Z0-9_-]+` per segment for unambiguous parsing. Buyers choose dimensions; the protocol does not enumerate them. See [implementation guide § fcap_keys label model](../docs/trusted-match/identity-match-implementation.mdx#fcap_keys-label-model).

### 3. Cross-identity dedup via `impression_id`, not merge rules

Records are keyed by `(uid_type, user_token)`. Buyers running their own identity graph can canonicalize before write/read; the protocol stays agnostic. Multi-identity dedup is handled at eligibility-check time by deduplicating exposure-log entries by `impression_id` — a single impression resolved to multiple identity tokens has the same `impression_id` written to all identity logs, and the read-time union recovers the count exactly.

This approach is correct by construction for **graphless and graph-canonicalizing operators alike**, with no merge-rule policy needed. Earlier drafts of this design proposed counter-based exposure tracking with a `merge_rule` (MAX/OR/SUM) policy field; that approach under-counts when identity resolution toggles across impressions (a real concern given Scope3 is graphless). The `adcp-go/targeting/` reference impl already uses log-based dedup; this spec aligns with the existing impl rather than the abandoned counter design. See [implementation guide § Identity handling and cross-identity dedup](../docs/trusted-match/identity-match-implementation.mdx#identity-handling-and-cross-identity-dedup).

### 4. `serve_window_sec` replaces `ttl_sec`

The original `ttl_sec` field was documented as a router cache TTL but operationally functioned as a per-package single-shot fcap. Two distinct concerns sharing one knob meant tuning for cost (long cache) silently broke fcap, and tuning for fcap (short cache) wasted IdentityMatch round-trips.

Replacement: `serve_window_sec` (1–300, default 60) with the corrected semantic — *after serving the user one impression on each eligible package within this window, the publisher MUST re-query Identity Match before serving from those packages again.*

`ttl_sec` is deprecated. 6-week notice published 2026-04-26; removal in a 3.0.x release ≥ 2026-06-07. During the window, senders SHOULD populate both fields with the same value; receivers SHOULD prefer `serve_window_sec`.

### 5. Two composable SDK primitives for impression handling, not one

Per Slack alignment with Baiyu (Scope3 impression-tracker owner):

```
decodeTmpx(raw_tmpx) -> ExposureLog            // pure crypto + parse
writeExposure(log, store_context) -> { ok }    // pure store interaction
```

Production topology is `pixel → tracking endpoint → pub/sub → frequency_writer → valkey`. A bundled `recordImpression()` would force synchronous topology and break the buffering pattern. Two composable functions let any topology compose them.

The same two primitives ship in `adcp-go`, `adcp-ts`, `adcp-py`. Spec/SDK is language-neutral; implementer picks the language that fits their infra.

### 6. TMP IdentityMatch service is a downstream read replica

The TMP server reads valkey on each `/identity` call. Writes go through the SDK directly to valkey (production management plane). No new wire endpoints for fcap policies, package CRUD, or impressions — all SDK-side. TMP server stays minimal.

### 7. `sync_audiences` is the audience on-ramp

The existing wire `sync_audiences` task has `add[]`/`remove[]` deltas of audience-member objects — exactly the CRUD shape the IdentityMatch backend needs. No schema extension required.

## Open questions

1. **`fcap_keys` generalization in `adcp-go/targeting`.** The reference impl currently uses scalar `package_id` and `campaign_id`; the spec defines arbitrary `fcap_keys` (advertiser, creative, line-item, etc.). Generalizing the reference impl is an in-flight refactor.
2. **Atomic exposure-log append.** Reference impl uses read-modify-write per identity, which is not atomic. Comment in `engine.go:478` explicitly accepts under-counting under contention as benign. Atomic append via Lua or a `Store.Append` method is a deferred optimization.
3. **Cap on policies per fcap_key.** One policy per key for v1; cross-cutting caps (per-day AND per-hour) are expressed as multiple keys.
4. **Identity-graph plug-point.** Pre-write/pre-read interceptors in the SDK. Default: identity passthrough.
5. **Pluggable store interface signatures.** Modeled on `adcp-go/targeting/store.go`. Specific TS/Python signatures pinned to `adcp-client#1005`.
6. **Where do fcap policies live on the wire (if anywhere)?** Currently SDK-only. Could embed in `create_media_buy` packages or add a new wire task. Decide before SDK ships.
7. **Audience strength scores.** Reference impl already supports per-segment scores in `UserProfile.Segments`. SDK should expose the strength floor at eligibility time.
8. **Production-deployment perf benchmarks.** Mock-store numbers cover the in-process eligibility path: realistic Scope3-shape load (1000 pkg × 1000 log × 3 ids) is ~7.5 ms CPU/request — comfortable. Pathological tail (1000 pkg × 10K log × 3 ids) is ~58 ms CPU/request — outside the 30 ms p95 budget. Network round-trip to real co-located valkey, cluster sharding, and tail-latency under load all need real benchmarks. Tracked as a rollout-plan deliverable.
9. **Pre-aggregate-per-fcap_key optimization** ([adcp-go#103](https://github.com/adcontextprotocol/adcp-go/pull/103) — landed as in-flight upstream PR). Pre-buckets the exposure log by filter hash once per request; per-package check walks only the matching bucket instead of re-scanning the full log. Heuristic-gated at `numPackages > 50` so small-package requests stay on the naive path (avoids a measured ~3× regression on small requests with heavy logs). Measured speedups: 1000 pkg × 1000 log × 3 ids: ~26×; 1000 pkg × 10K log × 3 ids: ~38× (pathological tail drops from 58ms to ~1.5ms, well within the latency budget).

## Deferred security & privacy issues (follow-up)

These came out of pre-merge review. Each warrants a focused follow-up rather than blocking this design landing.

1. **TMPX harvest → competitor-suppression attack.** TMPX in publisher creative URLs is harvestable. Without per-impression binding (creative_id, slot_id, ts) inside the AEAD AAD, an attacker fires harvested tokens at the buyer's impression endpoint to inflate fcap counts and starve a target user out of a campaign. Mitigation: bind TMPX to per-impression context, or rate-limit-per-token at the impression handler.
2. **Eligibility-as-audience-membership oracle.** A malicious publisher submits honeypot `package_ids` and observes which return eligible to reconstruct the user's audience profile. The "publishers don't see audience records" privacy claim is wire-correct but functionally false. Mitigation: package-ownership check at IdentityMatch ingress, or k-anonymity floor on eligibility responses.
3. **Consent revocation between IdentityMatch and impression.** TMPX has no consent fingerprint; if consent is revoked during the cache window, the impression handler still writes an exposure record. GDPR/TCF problem.
4. **Side-channel via eligibility deltas.** A router observing two responses for the same user 30s apart sees `eligible_package_ids` shrink as caps trip — fingerprinting fcap state per-user.
5. **`hashed_email` in TMPX widens identity-leak surface.** Putting unsalted SHA-256 email inside a creative URL macro re-identifies on token leak. Either prohibit `hashed_email` in TMPX plaintext or require salting.
6. **DoS amplification via large `package_ids[]`.** Per-IdentityMatch valkey reads scale `O(|identities| × |candidate_packages| × |fcap_keys_per_package|)` — at 25k packages from a busy publisher, this is an amplification primitive. Cap candidate_packages at IdentityMatch ingress.
7. **§Rollout work plan ownership gaps.** No named owner for the eligibility-evaluator hot path, observability/SLO, key-rotation drill, or load testing. Address before SDK ships.

## Rollout plan

### What this PR landed

- Wire spec change (additive): `serve_window_sec` field on `identity-match-response.json`, `ttl_sec` deprecation notice in `CHANGELOG.md`.
- Doc updates to `docs/trusted-match/specification.mdx`, `buyer-guide.mdx`, `migration-from-axe.mdx`.
- New page: `docs/trusted-match/identity-match-implementation.mdx` (implementation guide).
- This architecture-rationale doc.

### Next workstreams (not in this PR)

1. **`@adcp/client` V6 (TS)** — tracked under `adcp-client#1005`. Implements `decodeTmpx` / `writeExposure` / `upsertAudience` / `upsertPackage` / `upsertFcapPolicy` / `inspectExposure`. Pluggable store interfaces. Valkey reference connector. HPKE encrypt/decrypt.
2. **`adcp-go` and `adcp` (Python) parity** — same primitive surface as the TS SDK.
3. **`adcp-go/identitymatch` reference TMP server** — open-source read replica for `POST /identity`. Reads via the SDK's pluggable store interfaces.
4. **Scope3 hosted IdentityMatch** — public deployment for buyers who don't want to host their own service.
5. **Training agent integration** — hosts both AdCP MCP/A2A and TMP `/identity` surfaces, sharing valkey internally. End-to-end IdentityMatch demo.
6. **Conformance harness** — runner script that uses the SDK to seed state and asserts behavior, plus calls the TMP server's `/identity` to validate eligibility responses. Lives as integration tests inside `@adcp/client` and `adcp-go`. The five conformance scenarios in the [implementation guide](../docs/trusted-match/identity-match-implementation.mdx#conformance-scenarios) map directly onto runnable test cases.
7. **TMP graduation (target: 3.1.0)** — TMP enters `supported_protocols` (currently in `experimental_features` as `trusted_match.core`). At that point AdCP storyboards can wrap the SDK-driven harness if cross-protocol integration testing becomes useful.

## Threads consolidated from Slack 2026-04-26

- **Thread 1 (exposure struct location):** resolved by the three-layer model. Cross-language interop is at the Redis-operation level (`HINCRBY`, `SADD`); no proto, no JSON Schema for buyer-internal records. TMPX wire format stays as published in `docs/trusted-match/specification.mdx`.
- **Thread 2 (campaign isn't AdCP):** resolved by the `fcap_keys[]` label model. No fixed dimensions; customers choose. Tenant prefix required. Seller agent + package_id remains the seller-side identifier per `core/seller-agent-ref.json`.
- **Thread 3 (campaign logic in IdentityMatch):** resolved by the conformance invariants — backend-agnostic eligibility logic in the wire spec.
- **Thread 4 (campaign sync via Cerberus):** resolved — direct CRUD writethrough via SDK; no Cerberus.

## Threads consolidated from Slack 2026-04-30 (impression handling)

Per discussion with @bhuo (Scope3 impression-tracker owner) and Brian:

- The SDK ships impression handling as **two composable functions**, not a single bundled call. `decodeTmpx` (pure crypto + parse) and `writeExposure` (pure store interaction). Production deployments separate decode at intake (synchronous) from write downstream (asynchronous, behind a queue) for buffering. Bundling forces synchronous topology and breaks the pattern.
- "JS for writers, Go for reader" framing was wrong — Brian's "JS" was shorthand for "the language the impression tracker runs in," currently Go at Scope3. Spec/SDK is language-neutral; the same two primitives ship in `adcp-go`, `adcp-ts`, `adcp-py`.
- Pub/sub buffering, retries, dedup, observability, abuse protection are deployment concerns, not protocol concerns. SDK ships the building blocks; topology is the implementer's choice.

## Threads consolidated from PR #3359 review

- **@oleksandr's normative/reference layering question:** the original spec called the buyer-side valkey schema "normative" while leaving an open question for a pluggable FrequencyStore interface. Inconsistent. Resolved by the three-layer model — wire spec + conformance invariants are normative; reference data model is Scope3's implementation choice, swappable.
- **Brian: counters can't dedup across identities, what about an exposure log keyed per-identity with imp_id-based dedup?** Direct comparison led to walking through correctness (counter+MAX under-counts when identity resolution toggles, log+imp_id is exact), then perf math (counter pipelined ~10-30ms vs log ~3-10ms — log structurally faster). Surveyed `adcp-go/targeting/`: the log approach is **already implemented and shipping**. Spec was speculating about an architecture the codebase had already chosen. Pivot: spec rewritten to match the existing reference impl (per-identity binary exposure log with `impression_id` dedup, single MGet read pattern, sliding window via timestamp filter, prune-on-write). All the merge-rule, FIXED/SLIDING, counter-comparison content removed. Real perf numbers from `targeting/scale_test.go` substituted for envelope math.
- **`fcap_keys` generalization** (Brian's call: "B is what we want"): spec defines the label model (`tenant:dimension:value`) as the design direction. The current reference impl uses scalar `package_id`+`campaign_id`; generalizing it to arbitrary fcap_keys is an in-flight refactor in `adcp-go/targeting`. New buyer impls SHOULD build against the label model directly.
