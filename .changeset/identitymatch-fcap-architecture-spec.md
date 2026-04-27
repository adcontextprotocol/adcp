---
"adcontextprotocol": patch
---

IdentityMatch & frequency capping architecture spec, plus a wire-side fix to the response throttle field. Adds:

- `specs/identitymatch-fcap-architecture.md` — design spec consolidating the buyer-internal valkey schema, `fcap_keys[]` label model with required tenant-prefixing, identity-handling rules (no required canonicalization), and storyboard conformance scenarios behind TMP IdentityMatch.
- `identity-match-response.json` — adds `serve_window_sec` (integer, 1–300, default 60) and deprecates `ttl_sec`. The original `ttl_sec` field was documented as a router response cache TTL but operationally functioned as a per-package single-shot fcap, conflating two distinct concerns. `serve_window_sec` carries the corrected semantic: at most one impression per eligible package per user during this window. Multi-impression fcap is handled separately by buyer-side exposure records and policies.
- `CHANGELOG.md` — 6-week deprecation notice for `ttl_sec` removal per the experimental-status contract. Earliest landing: 2026-06-07.

The buyer-internal records (audience, exposure, package, fcap_policy) are documented as a **valkey schema** — Redis key patterns + primitive types (HASH / SET / ZSET) + field names within each. Cross-language interop between JS impression-trackers and Go IdentityMatch services is handled by Redis client libraries; agreement is at the operation level (`HINCRBY exposure:... count 1`, `SMEMBERS audience:...`), not via a binary serialization layer. No proto, no JSON Schema for these records — they aren't wire envelopes and they aren't binary blobs.

The TMPX wire format itself is **unchanged** — already specified in `docs/trusted-match/specification.mdx` as a compact binary layout with version/timestamp/country/8-byte nonce/typed identity entries, with replay defense via master-side nonce dedup.

JSON Schema continues to govern wire/RPC surfaces. Buyer-internal valkey records live in the spec doc as a Redis schema. Each contract uses the right tool for its job.

All TMP surfaces remain `x-status: experimental`. Wire change in this release is purely additive (`serve_window_sec`); the `ttl_sec` removal lands in a later 3.0.x release ≥ 6 weeks after notice. Storyboard YAML deferred until TMP graduates from `experimental_features` into `supported_protocols` — buyer SDKs implement the five conformance scenarios as integration tests now.

Several deferred security and privacy follow-ups are documented in the spec: TMPX harvest → competitor-suppression attack, eligibility-as-audience-membership oracle, consent revocation between IdentityMatch and impression, side-channel via eligibility deltas, hashed_email leak surface, and DoS amplification via large `package_ids[]`. None block this PR; each warrants a focused follow-up.
