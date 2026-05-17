---
"adcontextprotocol": minor
---

feat(training-agent): emit compact JWS governance_context with required plan_hash

The training agent now signs the `governance_context` it returns from `check_governance` per the [AdCP JWS profile](/docs/building/by-layer/L1/security#adcp-jws-profile), replacing the opaque UUID it previously emitted. Closes #2475.

**What's signed**

- Compact JWS with `alg: EdDSA`, `typ: adcp-gov+jws`, and a `kid` published on the aggregated `/.well-known/brand.json` alongside per-tenant transport keys (distinct `kid`, `adcp_use: "governance-signing"`, `use: "sig"`, `key_ops: ["verify"]`).
- All 13 spec claims emitted: `iss`, `sub`, `aud`, `iat`, `exp`, `jti` (UUID v7), `phase`, `caller`, `check_id`, `media_buy_id` (conditional), `policy_decisions`, `audit_log_pointer`, and the required audit-layer `plan_hash`.
- Intent tokens expire in 15 minutes; execution-phase (`purchase`/`modification`/`delivery`) in 30 days. Fresh signature on every check — no caching across plan revisions.

**`plan_hash` canonicalization**

- `base64url_no_pad(SHA-256(JCS(plan_payload)))` with the closed bookkeeping exclusion list applied in code.
- Validated bit-exactly against all 11 reference test vectors under `static/compliance/source/test-vectors/plan-hash/`.
- Per-revision `planAsSupplied` is retained in `revisionHistory` so historical tokens remain auditable after a subsequent `sync_plans` mutates state.

**Discovery surfaces**

- `/.well-known/brand.json` now includes the governance-signing JWK.
- New `/.well-known/governance-revocations.json` — signed (`typ: adcp-gov-revocation+jws`) flattened-JSON, empty by design, memoized on a 60-second cadence to prevent unbounded sign work under DoS.

**Sandbox-only behavior the spec calls out**

- `aud` defaults to the training agent's own sales tenant URL when `payload.target_seller` is omitted — every storyboard's downstream `create_media_buy` targets that URL, so the binding is honest for the test loop. Production governance agents MUST require buyer-supplied `target_seller` and refuse to issue without one.
- When the buyer requests a non-intent phase but omits `media_buy_id`, the token is issued at `phase: intent` rather than emit a structurally-valid-but-step-12-rejected token.
- Ephemeral Ed25519 keypair per process (same model as webhook-signing). KMS provisioning is the production answer; sandbox cert-track work is unblocked by the ephemeral pair.

Cert-track learners can now decode the JWS header, inspect the 13 claims, and verify the signature against the published JWKS — the training agent is a usable test-vector source for the JWS profile.
