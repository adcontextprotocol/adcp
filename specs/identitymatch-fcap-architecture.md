# IdentityMatch & Frequency Capping — Architecture Spec

**Status**: draft
**Target release**: 3.0.x (TMP is `x-status: experimental`)
**Related**: `static/schemas/source/tmp/`, `specs/prebid-tmp-proposal.md`, `docs/trusted-match/`
**Branch**: `bokelley/idmatch-design`

This spec defines the buyer-internal data model and SDK surface that sit behind TMP's IdentityMatch operation. The IdentityMatch wire spec already exists; what is missing is a clear architecture for the audience layer, exposure layer, frequency-cap policy layer, cross-language SDK scope, and conformance testing strategy. The goal is to land all of this concretely enough that feedback can be on real artifacts rather than threads.

## Problem

The current TMP IdentityMatch wire spec (`static/schemas/source/tmp/identity-match-{request,response}.json`) defines what flows on the wire: identity tokens in, eligible package IDs and an HPKE-encrypted exposure token (`tmpx`) out. It does not define:

1. **Buyer-side persistence model** — what records the buyer maintains in valkey to compute eligibility (audiences, exposures, fcap policy), and how those records are keyed.
2. **Frequency-cap semantics** — what dimensions a cap can apply to (campaign, advertiser, group, …) and how multi-identity users are handled.
3. **Cross-language SDK scope** — which SDKs need to read/write valkey, what shape the artifacts that cross language boundaries take, and how HPKE key management slots into existing AdCP key plumbing.
4. **Audience freshness** — how the audience and fcap state stay current relative to router-side response caching.
5. **Conformance** — how a third party validates that an IdentityMatch implementation is correct.

Without these decisions, the open-source IdentityMatch reference impl risks shipping with Go-shaped assumptions baked into wire-adjacent surfaces.

## Architectural decisions

### 1. The wire spec stays minimal; the buyer-internal model is where the design lives

The existing IdentityMatch request/response is the public protocol surface. Audience, exposure, and fcap-policy records are buyer-internal — defined by AdCP so that cross-language SDKs can interoperate against the same valkey, but **not on the wire**. Sellers, routers, and publishers never see fcap_keys, audience records, or exposure records.

This keeps the privacy boundary clean (publishers do not learn buyer fcap policy) and lets the buyer-internal model evolve faster than the wire spec.

**Two contracts, with the right tool for each:**

- **Wire / RPC** (HTTP JSON request/response) → JSON Schema under `static/schemas/source/tmp/`. Already integrated with the repo's docs and codegen pipeline.
- **Buyer-internal valkey schema** (audience, exposure, package, fcap_policy records) → documented in this spec as Redis key patterns + primitive types (HASH / SET / ZSET) + field names within each. Cross-language interop is handled by Redis client libraries; we don't need our own serialization layer for these records.

The valkey schema is not a binary blob format. JS impression-trackers and Go IdentityMatch services interoperate by agreeing on the **Redis-level operations** (`HINCRBY exposure:... count 1`, `SMEMBERS audience:...`), not by deserializing each other's bytes. That makes proto / JSON Schema / any custom serialization unnecessary at this layer.

### 2. `fcap_keys[]` as a label model, not hierarchy

A frequency cap is identified by a tag of the form `tenant:dimension:value` — e.g. `buyer-acme:campaign:42`, `buyer-acme:campaign_group:7`, `buyer-acme:advertiser:13`, `buyer-acme:creative:8`. Packages declare which `fcap_keys` they belong to; exposure records are written per-key; policies (window, max count) are attached per-key.

```
package 2342:                            fcap_keys ["buyer-acme:campaign:42",
                                                    "buyer-acme:campaign_group:7",
                                                    "buyer-acme:advertiser:13"]
policy "buyer-acme:campaign:42":         {window_sec: 60, max_count: 5}
policy "buyer-acme:advertiser:13":       {window_sec: 60, max_count: 20}
```

**Tenant prefix is required.** Multi-tenant buyer-agent fleets host multiple advertiser orgs; without a tenant prefix, `campaign:42` collides on shared valkey counters and tenant A learns B's reach by watching the counter move. SDKs MUST refuse keys without a tenant prefix.

**Charset constraint.** Each segment matches `[a-zA-Z0-9_-]+` so the `:` delimiter is unambiguous. URL-bearing or otherwise colon-bearing values must be hashed or shortened before use.

**Why labels not hierarchy**: dimensions are heterogeneous across customers (some want creative-level caps, some line-item, some flight, some advertiser-roll-up). A fixed schema either over-prescribes or under-serves. Labels also make cross-seller fcap automatic — any policy whose key is shared across sellers (e.g., `buyer-acme:advertiser:13`) enforces across all of them with no extra mode.

**Cross-cutting policies are explicit**, not implied. A campaign that needs both a per-campaign and a per-advertiser cap declares both keys and gets two policy lookups at check time. There is no implicit roll-up.

### 3. No required canonicalization of user identity

The protocol does **not** dictate a canonical user ID. Customers will use multiple identity providers (RampID, ID5, MAID, UID2, publisher-issued tokens) in parallel — Scope3's identity graph is canonical *only for Scope3-hosted IdentityMatch instances*. Other operators run their own graph or none at all.

Records are keyed by `(uid_type, user_token)`. A user with three resolved identities produces three records on each write, and reads merge across all the user's identities at check time:

```
exposure:buyer-acme:campaign:42:rampid:abc → {count: 3, …}
exposure:buyer-acme:campaign:42:id5:def    → {count: 2, …}
exposure:buyer-acme:campaign:42:maid:ghi   → {count: 1, …}
```

The `merge_rule` on `FcapPolicy` is **required** — there is no implicit default, because the right rule depends on whether the buyer canonicalizes upstream. The recommendation:

- `MAX` for buyers running an identity graph that canonicalizes upstream. Matches how Xandr / DV360 / TTD model multi-identity fcap; avoids over-counting when one impression resolves to two tokens.
- `OR` (count distinct identities exposed) only for graphless operators where identity tokens are known not to alias. Over-counts when the same impression carries multiple identities.
- `SUM` is rarely correct (assumes identities never co-occur for the same person).

Customers who **want** canonicalization run their identity graph behind their own door — pre-canonicalizing tokens before write/read on both the `sync_audiences` path and the TMPX-decrypt path, then setting `MERGE_RULE_MAX` since the merge becomes a no-op. The protocol does not know this happened.

### 4. Replace `ttl_sec` with `serve_window_sec` — fix a semantic drift, not just a cap

The existing `ttl_sec` field on `identity-match-response.json` was documented as "how long the router should cache this response" but operationally functioned as a per-package single-shot fcap — buyers expected each eligible package to be served at most once per user per window, and to be re-queried thereafter. Two distinct concerns (response caching vs frequency capping) sharing one knob means anyone tuning for cost (long cache) silently breaks fcap, and anyone tuning for fcap (short cache) pays unnecessary IdentityMatch load.

Replacement: new field `serve_window_sec` with the corrected semantic — *after serving the user one impression on each eligible package within this window, the publisher MUST re-query Identity Match before serving from those packages again.* Default 60, max 300. Anything longer than 300 makes the per-package cap too coarse for typical campaigns; anything shorter than the IdentityMatch round-trip wastes the throttle.

`ttl_sec` is deprecated. During the deprecation window:
- Senders SHOULD populate `serve_window_sec` AND `ttl_sec` with the same value.
- Receivers SHOULD prefer `serve_window_sec` when both are present.
- A future 3.0.x release ≥ 6 weeks after this notice publishes drops `ttl_sec` from `required` and removes it from the schema.

This is **not** a router response cache. Multi-impression frequency capping is a separate concern, handled by buyer-side `ExposureRecord` + `FcapPolicy` and updated out-of-band via TMPX impression callbacks regardless of `serve_window_sec`. Audience freshness is a third concern, handled by `sync_audiences` cadence — entirely independent of this window.

### 5. Two write paths into valkey, both buyer-side

| Path | Writer | Frequency | Records produced |
|---|---|---|---|
| `sync_audiences` | Buyer's audience pipeline (already specified in AdCP) | Continuous / batched | `(uid_type, user_token) → audience_ids[]` |
| Impression callback | Buyer's impression-tracking SDK (JS today, others later) | Per impression | `(fcap_key, uid_type, user_token) → exposure counter increment` |

A third path — package & policy CRUD — is buyer-control-plane (Nastassia's writethrough), populating `package → fcap_keys[]` and `fcap_key → policy` records. Not in the impression hot path.

## Wire spec changes

Additive changes to one existing schema, deprecation of one field. Lands additively in 3.0.1; the deprecated field removal lands in a later 3.0.x release ≥ 6 weeks after this notice.

### `identity-match-response.json`: add `serve_window_sec`, deprecate `ttl_sec`

New field `serve_window_sec` (integer, 1-300, default 60). Existing `ttl_sec` field reframed in its description and marked deprecated; both fields coexist during the 6-week deprecation window. Senders populate both with the same value; receivers prefer `serve_window_sec`.

The TMPX wire format itself is **unchanged** — already specified in `docs/trusted-match/specification.mdx:534-597` (16-byte header with version/timestamp/country/nonce/count plus typed identity entries) with replay defense via an 8-byte AEAD-protected nonce + master-side dedup.

## Buyer-side valkey schema (normative)

Four record types, each modeled directly on a Redis primitive. Cross-language interop is handled by Redis client libraries; agreement is at the operation level (`HINCRBY`, `SADD`, `SMEMBERS`), not at a serialization layer.

**This is a convention, not a schema in the database-enforced sense.** Valkey / Redis does not validate writes against a schema definition — the contract documented here is enforced by the SDK on the write side and by the IdentityMatch reader on the read side. A buggy writer can still corrupt the store; the protocol relies on library discipline, not database constraints. SDK conformance tests are how that discipline is verified.

### Audience record

```
type: SET                                    (or ZSET if strength scores are used)
key:  audience:{uid_type}:{user_token}
members: audience IDs the user belongs to
```

Optional companion HASH at `audience_meta:{uid_type}:{user_token}` for diagnostics:

```
type: HASH
fields:
  updated_at:  unix seconds last written
  expires_at:  unix seconds after which the SET MUST be ignored (0 = no deadline)
  source:      origin pipeline (typically "sync_audiences")
```

Written by the buyer's `sync_audiences` pipeline. Read at IdentityMatch eligibility time. Real-world `sync_audiences` cadences vary widely (prospecting segments are often hourly-to-daily batched; retargeting via streaming CDP can be near-real-time) — `expires_at` lets the pipeline publish freshness contracts directly on the record.

If using ZSET, the score carries audience strength (0.0–1.0); IdentityMatch can apply a strength floor at eligibility time.

### Exposure record

```
type: HASH
key:  exposure:{fcap_key}:{uid_type}:{user_token}
fields:
  count:         uint, exposures inside the current policy window
  first_seen:    unix seconds (sliding-window policies)
  last_seen:     unix seconds, most recent exposure
  window_start:  unix seconds when the current fixed window opened (0 = sliding)
```

Incremented on TMPX decrypt with `HINCRBY exposure:... count 1` plus `HSET ... last_seen <ts>`. Atomic by Redis primitive; no serialization. Window semantics (sliding vs fixed) are policy-attached, not record-attached.

### Package record

```
type: HASH
key:  package:{seller_agent.agent_url}:{package_id}
fields:
  media_buy_id:  string (optional, for diagnostics)
  active:        "1" | "0"
  updated_at:    unix seconds
```

Companion SETs for the multi-valued lookups:

```
type: SET
key:  package_fcap_keys:{seller_agent.agent_url}:{package_id}
members: e.g. "buyer-acme:campaign:42", "buyer-acme:advertiser:13"
```

```
type: SET
key:  package_audiences:{seller_agent.agent_url}:{package_id}
members: e.g. "seg_123", "seg_456"
```

Written by the buyer's package-CRUD writethrough. Set membership lets eligibility checks compute audience intersection via native `SINTER` rather than client-side iteration.

### fcap policy record

```
type: HASH
key:  fcap_policy:{fcap_key}
fields:
  window_sec:   uint
  window_kind:  "FIXED" | "SLIDING"
  max_count:    uint
  merge_rule:   "MAX" | "OR" | "SUM"   (required, no implicit default — see § 3)
  active:       "1" | "0"
  updated_at:   unix seconds
```

Written by the buyer's policy-CRUD writethrough.

## Eligibility flow (pseudocode)

```
function evaluate_eligibility(identities, candidate_package_ids):
    audiences = union(read("audience:{t.uid_type}:{t.user_token}").audience_ids for t in identities)

    eligible = []
    for pkg_id in candidate_package_ids:
        pkg = read("package:{pkg.seller_agent_url}:{pkg_id}")

        // Audience match
        if pkg.audience_ids and not pkg.audience_ids.intersects(audiences):
            continue

        // Frequency cap check across all fcap_keys on the package
        capped = false
        for fcap_key in pkg.fcap_keys:
            policy = read("fcap_policy:{fcap_key}")
            counts = [read("exposure:{fcap_key}:{t.uid_type}:{t.user_token}").count for t in identities]
            merged = merge(counts, policy.merge_rule)
            if merged >= policy.max_count:
                capped = true
                break
        if capped:
            continue

        eligible.append(pkg_id)

    return eligible
```

Per-impression valkey reads are bounded by `O(|identities| × |candidate_packages| × |fcap_keys_per_package|)` — typically `3 × 50 × 3 = 450` reads. Within reach of valkey pipelining at IdentityMatch latency budgets.

## Cross-language SDK scope

### HPKE encrypt/decrypt

HPKE is a **net-new primitive** for AdCP SDKs. Existing AdCP key plumbing publishes Ed25519/ECDSA verification keys via JWKS for request and webhook **signing** — it does not distribute X25519 KEM public keys for **encryption**. The TMPX key model is documented in `docs/trusted-match/specification.mdx:579-587` and lives on `adagents.json` `agents[].encryption_keys` — distinct from the signing JWKS.

Each SDK that adds HPKE needs:

- X25519 KEM keypair generation and `kid` derivation.
- ChaCha20-Poly1305 AEAD with HKDF-SHA256 KDF, per the published TMPX cryptosuite (RFC 9180 `mode_base`).
- Decrypt-side `kid` lookup against `encryption_keys`, with rejection-and-metric on unknown `kid` after refetch.
- Per-master nonce dedup window (recommended 7 days, per the published spec) for replay defense; this is the existing TMPX defense and is the buyer's responsibility, not the protocol's.

Where the existing plumbing helps: `kid` prefix conventions, the 5-minute JWKS-style cache TTL, and the rotation choreography (30-day grace for old master keys). These transfer cleanly. The cryptographic core does not.

| SDK | Signing today | HPKE needed | Priority |
|---|---|---|---|
| `@adcp/client` (JS) | ✅ | encrypt + decrypt | First — unblocks impression tracker |
| `adcp-go` | ✅ | decrypt (server) | Reference IdentityMatch impl |
| `adcp` (Python) | partial | encrypt + decrypt | Follows JS |

### Reference implementations

| Component | Repo / path | Language | Role |
|---|---|---|---|
| IdentityMatch service | `adcp-go/identitymatch` | Go | Open-source reference; processes IdentityMatch requests, applies eligibility, emits TMPX |
| Impression tracker | `@adcp/client/identitymatch` | JS/TS | Decrypts TMPX, increments exposures in valkey |
| Package/policy CRUD | `@adcp/client/identitymatch` | JS/TS | Writethrough on buyer's package & policy mutations |

### Why JS for the writers and Go for the reader

The impression tracker runs in the buyer's existing impression-tracking infra, which is overwhelmingly JS today (Baiyu's existing tracker). Wrapping in Go adds a process boundary for no benefit — JS appends directly to valkey. Same for package/policy CRUD: Nastassia's control plane is JS already.

The IdentityMatch service is hot-path request handling and benefits from Go's concurrency model and the Prebid Server integration story. It reads from the same valkey schemas the JS writers populate.

## Storyboard conformance scenarios

The model gives clean invariants that map to runnable AdCP storyboards:

1. **Per-key cap trips**: 5 impressions on `buyer-acme:campaign:42` → user drops off any package mapped to that key within `serve_window_sec`.
2. **Multi-identity merge (MAX)**: 3 impressions on RampID and 2 on ID5 (same person, `MERGE_RULE_MAX`) → merged count is 3; 6th impression on either identity (now 4 max) is still under cap; 9th identity-aggregated impression trips a cap of 5.
3. **Audience drift**: `sync_audiences` removes user from segment → eligibility on packages requiring that segment drops within `sync_lag + serve_window_sec`.
4. **Cross-seller advertiser cap**: 10 impressions on Seller A across `buyer-acme:advertiser:13` → identical request to Seller B for a different package mapped to the same key returns ineligible.
5. **Serve-window throttle**: After `serve_window_sec` expires, the publisher re-queries Identity Match and gets a fresh response; no router-side stale-cache surface.

These scenarios are the IdentityMatch conformance suite. Buyer SDK teams SHOULD implement them as integration tests now, even though the AdCP storyboard YAML is deferred (see implementation note).

**Implementation note**: `supported_protocols` is a closed enum today (`media_buy`, `signals`, `governance`, `sponsored_intelligence`, `creative`, `brand`) and the compliance runner discovers test paths from it. TMP is declared via `experimental_features` (`trusted_match.core`), not `supported_protocols`, so `static/compliance/source/protocols/trusted-match/` is not yet a valid runner path. Storyboard YAML lands when TMP graduates from experimental status (targeted 3.1.0 per the 3.0.0 changelog) and `trusted_match` enters the `supported_protocols` enum. Until then the five scenarios above serve as the contract for buyer SDK / reference-impl unit and integration tests.

## Release plan

| Change | Type | Vehicle | Notes |
|---|---|---|---|
| Buyer-side valkey schema spec | Additive (doc only) | 3.0.1 | This document. Records are Redis primitives; no new artifact type needed. TMPX plaintext format already specified in `docs/trusted-match/specification.mdx`. |
| Add `serve_window_sec` to `identity-match-response.json` | Additive | 3.0.1 | New field; default 60, max 300 |
| Deprecate `ttl_sec` on `identity-match-response.json` | Deprecation notice | 3.0.1 (notice) → 3.0.x ≥ 6 weeks after | Per experimental contract; field removed in a later 3.0.x |
| HPKE encrypt/decrypt in `@adcp/client` (JS) | SDK | Out of band of AdCP release | `@adcp/client` versioning |
| `adcp-go/identitymatch` reference impl | New repo/module | Out of band | Tracks AdCP versions |
| Storyboard scenarios (YAML) | New scenarios | Deferred to TMP graduation (targeted 3.1.0) | Buyer SDKs implement as integration tests now |

## Open questions

1. **Window semantics.** Sliding window vs fixed window vs exponential decay. Sliding is most common in DSPs but heavier on storage (need impression timestamps, not just counts). Default proposal: fixed window aligned to `window_sec` boundary, with `last_seen` recorded for diagnostics.
2. **Audience-record TTL inside valkey.** `sync_audiences` writes are continuous. How long do stale audience records linger? Proposal: `expires_at` field on the audience-meta HASH; SDK ignores SET members whose meta-hash has expired.
3. **Cap on policies per fcap_key.** Should multiple policies stack on one key (e.g., per-day AND per-hour), or one policy per key? Proposal: one policy per key for v1; stacking is implementable as multiple keys.
4. **Identity-graph plug-point.** For operators that *do* canonicalize, where does the graph hook in? Proposal: SDK exposes pre-write and pre-read interceptors (`(uid_type, user_token) → (uid_type', user_token')`) that customers wire to their graph. Default: identity passthrough.
5. **`FrequencyStore` interface for DSP coexistence.** Buyers with existing fcap stores (Aerospike/Redis/proprietary) won't migrate to valkey. SDK should expose a `FrequencyStore` interface; valkey is the reference implementation, customers plug their own. Symmetric to the canonicalization plug-point above.
6. **OpenRTB cross-walk.** OpenRTB 2.6 `User.eids[]` matches our `identities[]` shape; should the spec note the mapping for buyer-side codebases that bridge between protocols?
7. **Audience strength scores.** ZSET allows audiences to carry a strength/score; eligibility can apply a floor at check time. v1 ships SET; ZSET migration is a buyer-internal choice that doesn't affect the protocol.

## Deferred security & privacy issues (follow-up)

These came out of pre-merge review and are real concerns that the current design does not address. Each warrants a focused follow-up rather than a polish pass on this spec:

1. **TMPX harvest → competitor-suppression attack.** TMPX rendered into publisher creative URLs is harvestable. With no per-impression binding (creative_id, slot_id, ts) inside the AEAD AAD, an attacker fires harvested tokens against the buyer's impression endpoint to inflate fcap counts and starve a target user out of a campaign. Mitigation needs binding to per-impression context, sender-binding, or rate-limit-per-token at the impression handler. Out of scope for this PR; tracked as a TMPX security follow-up.
2. **Eligibility-as-audience-membership oracle.** A malicious publisher submits honeypot `package_ids` and observes which return eligible to reconstruct the user's audience profile. The "publishers don't see audience records" privacy claim is wire-correct but functionally false. Mitigations: package-ownership check at IdentityMatch ingress, or k-anonymity floor on returned eligibility. Out of scope; tracked as a privacy follow-up.
3. **Consent revocation between IdentityMatch and impression.** TMPX has no consent fingerprint; if consent is revoked during the cache window, the impression handler still writes an exposure record. GDPR/TCF problem. Either include a consent fingerprint in TMPX plaintext (requires extending the published format) or document that fcap writes survive revocation as non-personal aggregates (legally tenuous). Tracked as a privacy follow-up.
4. **Side-channel via eligibility deltas.** A router observing two IdentityMatch responses for the same user 30s apart sees `eligible_package_ids` shrink as caps trip, fingerprinting fcap state per-user. The existing caching contract (fixed-response-for-window) limits this. Tracked as a privacy follow-up.
5. **`hashed_email` in TMPX widens the identity-leak surface.** Putting unsalted SHA-256 email inside a creative URL macro re-identifies on token leak. Either prohibit `hashed_email` in the plaintext or require salting. Tracked as a TMPX security follow-up.
6. **DoS amplification via `package_ids[]` size.** Per-IdentityMatch valkey reads scale `O(|identities| × |candidate_packages| × |fcap_keys_per_package|)` — at 25k packages from a busy publisher this becomes an amplification primitive. Cap candidate_packages at IdentityMatch ingress. Tracked as an operational follow-up.
7. **§13 work plan ownership gaps.** No named owner for the eligibility-evaluator hot path, observability/SLO, key-rotation drill, or load testing. Address before SDK ships.

## Boiled-down work plan

(Replaces the original Slack breakdown.)

1. **Spec changes (this doc → PRs against AdCP)**
   - Add `static/proto/tmp/v1/{exposure_record,audience_record,package_record,fcap_policy}.proto` plus shared `uid_type.proto`
   - Add `serve_window_sec` to `identity-match-response.json` and deprecate `ttl_sec` (lands additively in 3.0.1; field removal in a 3.0.x ≥ 6 weeks out)
   - Storyboard YAML under `static/compliance/source/protocols/trusted-match/` — deferred until TMP enters `supported_protocols`. Buyer SDKs implement the five scenarios as integration tests now.
2. **JS SDK (`@adcp/client`, JS team)**
   - HPKE encrypt + decrypt (net-new primitive — see § HPKE)
   - Impression-tracking writer (decrypts TMPX per the published binary format, increments exposures)
   - Package/policy CRUD writethrough client
   - `FrequencyStore` interface (valkey reference impl + plug-point)
3. **Go reference impl (`adcp-go/identitymatch`)**
   - HPKE decrypt
   - Eligibility evaluator against the buyer-side data model
   - Conformance harness running storyboard scenarios as integration tests
4. **Prebid wiring**
   - TMP router → IdentityMatch service connection
   - Already scoped in `specs/prebid-tmp-proposal.md`

## Conformance scenario walkthroughs

Each of the five scenarios in § Storyboard conformance maps to a runnable sequence of wire calls and buyer-internal operations against a live valkey. These are the integration-test contracts buyer SDKs implement today; they become storyboard YAMLs once TMP enters `supported_protocols` and the test-controller scenarios below exist.

All walkthroughs assume:
- `serve_window_sec = 60` on every IdentityMatch response (default)
- Identity Match service is the **buyer agent**; caller is a publisher / router (or test runner standing in for one)
- "Buyer-internal step" is a step the SDK harness executes against valkey directly, NOT a wire call. These map to `comply_test_controller` scenarios that need to be added (see § Conformance harness scope).
- `tenant = "buyer-acme"`, `package = "pkg-42"`, `seller_agent_url = "https://seller-a.example"` throughout.

### Scenario 1 — per-key cap trips after N exposures

**Setup (buyer-internal):**
```
SADD package_fcap_keys:https://seller-a.example:pkg-42 buyer-acme:campaign:42
HSET fcap_policy:buyer-acme:campaign:42 window_sec 86400 window_kind FIXED \
                                        max_count 5 merge_rule MAX active 1
HSET package:https://seller-a.example:pkg-42 active 1
SADD package_audiences:https://seller-a.example:pkg-42 seg_test_users
SADD audience:rampid:abc seg_test_users
```

**Step 1** — wire call: `identity_match_request {identities: [{rampid, abc}], package_ids: [pkg-42]}` → expect `eligible_package_ids: [pkg-42]`, `serve_window_sec: 60`, `tmpx: <opaque>`.

**Step 2** — buyer-internal, repeat 5×: decrypt TMPX from response, then for each (uid_type, user_token) inside:
```
HINCRBY exposure:buyer-acme:campaign:42:rampid:abc count 1
HSET    exposure:buyer-acme:campaign:42:rampid:abc last_seen <ts>
```
After 5 iterations: `HGET exposure:buyer-acme:campaign:42:rampid:abc count` returns `5`.

**Step 3** — wire call: same `identity_match_request` → expect `eligible_package_ids: []` (cap tripped, package dropped).

### Scenario 2 — multi-identity merge (MAX rule)

**Setup:** same as Scenario 1, plus the user has two resolved identities (rampid `abc` and id5 `def`).

**Step 1** — buyer-internal, simulate prior exposures across identities:
```
HSET exposure:buyer-acme:campaign:42:rampid:abc count 3
HSET exposure:buyer-acme:campaign:42:id5:def    count 2
```

**Step 2** — wire call: `identity_match_request {identities: [{rampid, abc}, {id5, def}], package_ids: [pkg-42]}`.

Eligibility check inside the buyer agent reads both records and applies `MERGE_RULE_MAX`:
```
counts = [HGET exposure:...rampid:abc count, HGET exposure:...id5:def count]
       = [3, 2]
merged = MAX(3, 2) = 3
```
3 < max_count of 5 → `eligible_package_ids: [pkg-42]`.

**Step 3** — buyer-internal, simulate 2 more impressions on rampid:
```
HINCRBY exposure:buyer-acme:campaign:42:rampid:abc count 2  → count = 5
```

**Step 4** — wire call: same request → `MAX(5, 2) = 5 ≥ max_count` → `eligible_package_ids: []`.

If the policy were `MERGE_RULE_OR` (count distinct identities exposed), step 2 would have merged to `count_nonzero(3,2) = 2`, and step 4 to `2`. OR-merge would not trip until five distinct identities had been exposed — the over-counting concern.

### Scenario 3 — audience drift via sync_audiences

**Setup:** as Scenario 1, with the user initially in `seg_test_users`.

**Step 1** — wire call: `identity_match_request` → `eligible_package_ids: [pkg-42]`.

**Step 2** — buyer-internal, simulate `sync_audiences` removing the user from the segment:
```
SREM audience:rampid:abc seg_test_users
HSET audience_meta:rampid:abc updated_at <ts>
```

**Step 3** — wait `serve_window_sec` seconds (60) so the publisher re-queries.

**Step 4** — wire call: same `identity_match_request`. Buyer agent computes audience intersection:
```
user_audiences = SMEMBERS audience:rampid:abc           → []
package_audiences = SMEMBERS package_audiences:...:pkg-42 → [seg_test_users]
intersection = ∅ → package dropped
```
Expect `eligible_package_ids: []`.

### Scenario 4 — cross-seller advertiser cap

**Setup:** two packages on different sellers, both mapped to the same `advertiser:13` cap:
```
SADD package_fcap_keys:https://seller-a.example:pkg-A buyer-acme:advertiser:13
SADD package_fcap_keys:https://seller-b.example:pkg-B buyer-acme:advertiser:13
HSET fcap_policy:buyer-acme:advertiser:13 window_sec 86400 max_count 10 \
                                          merge_rule MAX active 1
```

**Step 1** — wire call to buyer agent (request from Seller A): `package_ids: [pkg-A]` → eligible.

**Step 2** — buyer-internal, simulate 10 impressions on Seller A's package:
```
HSET exposure:buyer-acme:advertiser:13:rampid:abc count 10
```

**Step 3** — wire call (request from Seller B): `package_ids: [pkg-B]`. Buyer agent reads `exposure:buyer-acme:advertiser:13:rampid:abc.count = 10 ≥ max_count` → `eligible_package_ids: []`.

The advertiser-level cap enforces across sellers because the `fcap_key` is shared. No cross-seller coordination needed; the buyer agent is the single source of truth.

### Scenario 5 — serve_window throttle

**Setup:** as Scenario 1, with audiences and policy in place.

**Step 1** — wire call at `t=0`: `identity_match_request` → `eligible_package_ids: [pkg-42]`, `serve_window_sec: 60`.

**Step 2** — publisher serves one impression on pkg-42 within the 60s window.

**Step 3** — at `t=30s`, publisher receives another ad opportunity for the same user. Per `serve_window_sec` semantic, the publisher MUST NOT re-serve pkg-42 from the cached eligibility — pkg-42 is exhausted in this window.

**Step 4** — at `t=61s`, publisher re-queries: `identity_match_request` → fresh eligibility computed from current valkey state. No router-side stale cache; the only "cache" is the publisher's commitment to honor the serve_window.

This is the semantic the wire field encodes. The buyer agent does not need to track per-publisher window state; it just answers freshly when re-queried.

## Conformance harness scope

To run these scenarios automatically through the AdCP compliance runner once TMP enters `supported_protocols`, three pieces are needed:

1. **`comply_test_controller` scenarios for buyer-internal steps.** The runner can already simulate AdCP tasks; it cannot today simulate impression callbacks or audience syncs. New scenarios:
   - `simulate_impression_callback`: takes `tmpx`, `fcap_keys[]`, `count` — applies `HINCRBY` against the buyer's valkey
   - `simulate_audience_membership`: takes `(uid_type, user_token, audience_ids[])` — writes `audience:` SETs
   - `simulate_package_record`: takes a full PackageRecord shape — writes the package + companion SETs
   - `simulate_fcap_policy`: takes a full FcapPolicy shape — writes the policy HASH
   - `inspect_exposure`: returns the current exposure count for a `(fcap_key, uid_type, user_token)` triple — for assertion
2. **Storyboard YAMLs at `static/compliance/source/protocols/trusted-match/scenarios/`** — five files mapping the scenarios above to runner-executable phases. Each phase alternates wire calls (`identity_match`) with `comply_test_controller` calls.
3. **TMP enters `supported_protocols`** so the runner discovers the protocol path. Currently TMP is in `experimental_features` (`trusted_match.core`); graduation is targeted for 3.1.0.

Buyer SDK teams implementing IdentityMatch SHOULD wire these scenarios as integration tests against a real valkey *now*, using the walkthroughs above as the contract. The work to formalize them as storyboard YAMLs lands when the test-controller scenarios are designed (separate PR, target 3.1.0).

## OpenRTB cross-walk

The `identities[]` shape on `identity-match-request.json` maps to OpenRTB 2.6 `User.eids[]` for buyer-side codebases that bridge protocols. Mapping:

| AdCP TMP `identities[].uid_type` | OpenRTB 2.6 `User.eids[].source` |
|---|---|
| `rampid` / `rampid_derived` | `liveramp.com` (`atype: 1` for maintained, `atype: 3` for derived) |
| `id5` | `id5-sync.com` |
| `uid2` | `uidapi.com` (`atype: 3`) |
| `euid` | `euid.eu` |
| `pairid` | `iabtechlab.com/pair` |
| `maid` | `adid` (Android) / `idfa` (iOS) on `Device.ifa` instead of `User.eids` — atypically carried |
| `hashed_email` | `liveintent.com` or buyer-specific (`atype: 3`) |
| `publisher_first_party` | publisher-defined `source` URL |
| `other` | buyer-defined `source` URL |

The TMP `user_token` field corresponds to `User.eids[].uids[].id`. AdCP carries up to 3 identities (HPKE size budget); OpenRTB has no such limit, so a buyer bridging from OpenRTB into TMP must apply the buyer-configured priority order to truncate.

## Next steps & rollout plan

This PR is the architecture-decision foundation. The wire-spec delta is intentionally minimal (one additive field, one deprecation) so that review is focused on architecture rather than schema breadth. Six follow-up workstreams take this from spec to deployable infrastructure. They run partially in parallel; ordering reflects dependency, not time.

### 1. Doc promotion: `specs/` → `docs/trusted-match/` (target: ~1 week after this lands)

Selected sections of this spec move to authoritative protocol docs:

| Content | Destination |
|---|---|
| `serve_window_sec` semantic + `ttl_sec` deprecation | `docs/trusted-match/specification.mdx` (already on the wire) |
| `fcap_keys` label model + tenant-prefix + charset | new `docs/trusted-match/buyer-fcap-implementation.mdx` |
| Valkey schema (Redis primitives, key patterns, field names) | same new buyer-fcap page |
| `merge_rule` semantics + per-mode recommendations | same |
| Redis-command walkthroughs for the 5 conformance scenarios | same |
| OpenRTB `User.eids` cross-walk | folded into existing `docs/trusted-match/migration-from-axe.mdx` or sibling page |
| Architecture rationale, thread resolutions, deferred follow-ups | **stays** in this spec doc |

The split: authoritative implementation guidance moves to `docs/`; design history stays in `specs/`. SDK teams build against `docs/`.

### 2. JS SDK: `@adcp/client` V6 (tracked: adcp-client#1005)

New namespace `client.identityMatch.*` with five methods that constitute the buyer-side management plane and the test harness driver:

```
client.identityMatch.upsertAudience(audience_id, members, opts)   // wraps sync_audiences add/remove deltas
client.identityMatch.upsertPackage(seller_agent_url, package_id, fcap_keys, audience_ids, opts)
client.identityMatch.upsertFcapPolicy(fcap_key, {window_sec, window_kind, max_count, merge_rule})
client.identityMatch.recordImpression(tmpx, opts)                 // decodes TMPX, HINCRBY exposure
client.identityMatch.inspectExposure(fcap_key, uid_type, user_token)  // test-only assertion helper
```

Plus HPKE encrypt/decrypt as net-new SDK primitives (X25519 KEM, ChaCha20-Poly1305, HKDF-SHA256 per RFC 9180 `mode_base`). The encrypt path is needed by the buyer agent emitting TMPX; decrypt by the impression handler.

### 3. Reference TMP server: `adcp-go/identitymatch`

A read-only TMP provider implementing `POST /identity` (and `POST /context` if scope expands). Reads the valkey schema this PR documents; serves `eligible_package_ids` + TMPX. Cites the buyer-fcap docs page once doc promotion lands.

No new endpoints — TMP stays a downstream read replica. Deploy this binary, point publishers/routers at it, populate state via the SDK.

### 4. Training agent integration

The training agent hosts both surfaces: its existing AdCP MCP/A2A endpoint (handles `sync_audiences`, `create_media_buy`, etc.) AND a TMP `/identity` endpoint sharing the same valkey. End-to-end IdentityMatch demo lives here. Becomes both the learning environment and the integration test for the SDK + reference impl.

### 5. Conformance harness

The harness is a runner script that uses the SDK to seed state and assert behavior, plus calls the TMP server's `/identity` endpoint to validate eligibility responses. Lives as integration tests inside `@adcp/client` and `adcp-go`. The five scenarios in § Storyboard conformance map directly onto runnable test cases. No new protocol surface required.

### 6. TMP graduation (target: 3.1.0)

When TMP enters `supported_protocols` (currently in `experimental_features` as `trusted_match.core`), AdCP storyboards can wrap the SDK-driven harness if cross-protocol integration testing becomes useful. Until graduation, the SDK + reference impl harness IS the conformance suite.

### Tracked deferred follow-ups

These are real concerns from pre-merge review that this PR explicitly does NOT address. Each warrants a focused follow-up issue once the architecture lands:

- **TMPX harvest → competitor-suppression attack** (security): need per-impression binding (creative_id, slot_id, ts) inside the AEAD AAD, or rate-limit-per-token at impression handler.
- **Eligibility-as-audience-membership oracle** (privacy): need k-anonymity floor or package-ownership check at IdentityMatch ingress.
- **Consent revocation between IdentityMatch and impression** (privacy/legal): need consent fingerprint in TMPX plaintext OR documented "fcap writes survive revocation" stance.
- **Side-channel via eligibility deltas** (privacy): router observation of changing eligibility leaks fcap state.
- **`hashed_email` in TMPX widens leak surface** (security): prohibit unsalted `hashed_email` in plaintext or require salting.
- **DoS amplification via large `package_ids[]`** (operational): cap candidate_packages at IdentityMatch ingress.
- **Where do fcap policies live?** Open: SDK-only (current proposal), wire field on `create_media_buy`, or new wire task. Decide before SDK ships.
- **Identity-graph plug-point interface** for buyers running their own canonicalization: SDK pre-write/pre-read interceptors. Decide before SDK ships.

## Threads consolidated from Slack 2026-04-26

- Thread 1 (exposure struct location): resolved by § "Buyer-side valkey schema." Cross-language interop is at the Redis-operation level (`HINCRBY`, `SADD`), not via a binary serialization layer; no proto / JSON Schema / custom format needed. The TMPX wire format itself stays as published in `docs/trusted-match/specification.mdx`.
- Thread 2 (campaign isn't AdCP): resolved by § fcap_keys[] label model. No fixed dimensions; customers choose. Tenant prefix required. Seller agent + package_id remains the seller-side identifier per `core/seller-agent-ref.json`.
- Thread 3 (campaign logic in IdentityMatch): resolved by § Eligibility flow.
- Thread 4 (campaign sync via Cerberus): resolved by § Two write paths. Direct CRUD writethrough; no Cerberus.
