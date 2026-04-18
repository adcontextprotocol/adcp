---
"adcontextprotocol": minor
---

Define the AdCP RFC 9421 request-signing profile — transport-layer request authentication for mutating operations. In 3.0 the profile is **optional and capability-advertised** via `request_signing` on `get_adcp_capabilities`; in 4.0 it becomes required for spend-committing operations. The substrate ships in 3.0 so early adopters can surface canonicalization and proxy interop bugs before enforcement.

**Scope boundary.** A valid signature proves only that the request came from the agent whose key signed it. Whether that agent is *authorized* to act for the brand named in the request body is a separate concern, governed by the target house's `authorized_operator[]` in brand.json. This profile defines authentication only — authorization lookup is an existing protocol concern and happens whether requests are signed or not.

**Design properties now specified:**

- **Canonical profile shape**: covered components pinned to `@method`, `@target-uri`, `@authority`, `content-type` (plus `content-digest` when the verifier opts in), sig-params pinned to `created`/`expires`/`nonce`/`keyid`/`alg`/`tag`, tag namespace `adcp/request-signing/v1`, alg allowlist `ed25519` / `ecdsa-p256-sha256`. Cross-implementation interop is the goal — every implementer signs and verifies the same bytes.
- **Agent-granular signing**: every agent that signs — of any `type` — publishes keys at its own `jwks_uri` in its `agents[]` entry. Same pattern as #2316 governance agents. Per-agent keys scope compromise and match the existing brand.json agent-declaration model.
- **Shared JWKS discovery with #2316**: one publication pattern for governance JWS, request-signing 9421, and (by convention) TMP Ed25519. Cross-purpose key reuse forbidden via `key_ops` and `kid` separation; verifiers enforce.
- **Content-digest opt-in**: `covers_content_digest: false` default in 3.0 preserves CDN/proxy compatibility. Verifiers that require body-binding opt in per-call; buyers test end-to-end before enabling.
- **12-step verifier checklist**: parallels the governance profile's 15-step checklist, short-circuits on first failure, establishes agent identity only.
- **Bounded transport replay dedup**: per-`(keyid, nonce)` with TTL = signature validity (≤ 300 s). In-memory LRU for moderate scale; Redis `SETNX` above ~10K req/s.
- **Transport revocation**: operators serve a single combined revocation list covering governance and request-signing keys, distinguished by `key_ops`. Same `next_update` polling rules as governance (floor 1 min, ceiling 15 min), same fetch-failure safe-default.
- **Stable error taxonomy**: `request_signature_*` codes parallel to the governance `governance_*` codes, surfaced in `WWW-Authenticate: Signature error="<code>"` and SDK typed errors.
- **TMP out of scope** for per-request 9421 verification (budget is too tight); TMP keys publish on the same `jwks_uri` path with distinct `kid` and `key_ops: ["verify"]`.
- **Reference verifier**: ~40-line TypeScript implementation in `security.mdx` using `jose` for JWKS handling and a pluggable 9421 library.

**Conformance**: `static/test-vectors/request-signing/` ships 10 negative vectors (each failure mode of the verifier checklist) and 3 positive vectors (basic Ed25519 POST, Ed25519 POST with content-digest covered, ES256 POST for edge-runtime profile). The README documents the fixture format and the generation process for positive-vector signatures.

**Schema changes**:

- `brand.json` `brand_agent_entry.jwks_uri` description generalized — the field now supports any agent type that signs (request-signing and governance), not only governance agents. No structural change.
- `get-adcp-capabilities-response.json` adds top-level `request_signing` object with `supported`, `covers_content_digest`, `required_for`, `supported_for`.

**Migration**:

- **3.0 GA**: verifiers ship with `required_for: []`. Signers MAY sign; verifiers MAY validate. No counterparty is required to implement.
- **3.x**: reference SDKs (to land in `@adcp/client`) ship signing and verification. Early adopters opt in via per-counterparty `required_for` pilots, surfacing canonicalization and proxy interop issues.
- **4.0**: `required_for` MUST include all spend-committing operations the verifier supports. Signers MUST sign. The 3.x substrate makes the flip feasible without ecosystem-wide breakage.

Reference v4.0 tracking issue: #2307. Paired SDK implementation tracked in the `@adcp/client` repository.
