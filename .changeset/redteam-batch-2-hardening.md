---
---

spec/impl/server: close the remaining red-team findings on top of the
root-of-trust fix — 28 discrete hardening items across the security,
webhook, idempotency, registry, and authentication surfaces

The first pass landed the R-1 root-of-trust framing (`aded76461` +
`5091ddff5` + `5978cc2e6`). This changeset lands the remaining batch —
auth, webhooks, idempotency, registry, and server code — so the 3.0
spec stops leaving the deferred items as inferred obligations and
instead names each one with a normative MUST/SHOULD and an error code.

No wire-breaking schema changes. Where a new capability field is
introduced (`webhook_signing`, `identity.per_principal_key_isolation`,
`identity.key_origins`, `identity.compromise_notification`,
`idempotency.account_id_is_opaque`), the field is additive and
capability-gated so existing agents continue to interoperate.

**Security (`docs/building/implementation/security.mdx`)**

- S-4: HMAC secrets MUST be ≥256 bits of CSPRNG entropy with 90-day
  rotation and a 10-minute dual-accept overlap; bearer-on-mutating-
  webhooks goes from SHOULD to MUST in 3.1
- S-6: origin separation — governance signing keys MUST be served from
  a separate origin than transport and webhook signing keys; the
  canonical pattern is `governance-keys.{org}.example/.well-known/
  jwks.json` vs `keys.{org}.example/.well-known/jwks.json`; operators
  advertise the scheme via `identity.key_origins` in
  `get_adcp_capabilities`
- S-7: consolidated token-lifetime table (financial ≤15 min, read ≤1 h,
  refresh ≤24 h rotation-on-use); replaces the symmetric
  `jwt.verify(token, secret)` example with an asymmetric `jwtVerify`
  call against a pinned JWKS
- S-8: governance signing keys MUST be generated inside and MUST NOT
  leave a FIPS 140-2 L2 HSM/KMS; example swaps `secretManager.get`
  for the AWS KMS `Sign` API
- S-9: tamper-evident audit storage — WORM MUST, `prev_hash` chain
  MUST, RFC 3161 timestamping SHOULD-consider
- S-10: SSRF deny-list expansion — NAT64 `64:ff9b::/96`, link-local
  `fe80::/10`, ULA `fc00::/7`, reserved TLDs, CNAME-chain resolution,
  5 MB / 10 s ceilings are now MUST
- S-12: RLS prose rewritten to acknowledge `SUPERUSER` / `BYPASSRLS` /
  `SECURITY DEFINER` — the DB role running the app MUST NOT hold any
  of those
- S-13: `Set.has()` in place of `Array.includes` in the hot-path
  example
- S-14: new **Logging Hygiene** section — MUST NOT log full tokens,
  PII, or full idempotency keys
- S-15: new **Supply Chain** section — SBOM, Sigstore/cosign signing
- S-16: modernized HTTP security headers — HSTS, CSP, Referrer-Policy,
  Permissions-Policy, COOP/COEP, X-Content-Type-Options
- S-17: new **Rate Limiting** section — 401-probe floor, SSRF-reject
  floor, JWKS-fetch floor
- S-18: data-classification table — PII, Financial, Inventory,
  Governance-audit retention windows
- I-5: opaque `account_id` via HKDF-SHA256(salt, "adcp-account-id-v1",
  natural_key) → 128-bit base32 with
  `idempotency.account_id_is_opaque` capability
- I-7: new **Commit ordering** section — two-phase pending→complete
  MUST, write-ahead before any external side effect
- I-8: capability schemas MAY annotate rotating-value fields with
  `"x-idempotency-excluded": true`; lint rule `no-rotating-fields-in-
  ext` SHOULD for 3.x, tracked for schema enforcement in a follow-up
- R-7: JWKS cache TTL SHOULD 5 min / MUST NOT exceed 15 min; revocation
  polling SHOULD 1 min / MUST NOT exceed 5 min for mutating verifiers
- W-2: `MODE_MISMATCH` error code + MUST (was SHOULD) reject on any
  strip-or-inject of the `Authentication` block; narrow 3.0-era
  exception with explicit 4.0 GA sunset
- W-7: `@authority` canonicalization rule inlined in the webhook
  verifier checklist, step 10
- W-8: generalized base64url rule — `Signature`, `Content-Digest`,
  nonce MUST reject `+`, `/`, `=`
- W-11: revocation endpoint CDN SLA ≥99.99% + the revocation-push
  webhook option + narrowed fail-closed (only reject tokens issued
  after the last successful revocation fetch)
- W-12: tag-version bump requirement for any sig-param addition

**Webhooks (`docs/building/implementation/webhooks.mdx`)**

- W-5: `verifyHmac` helper hashes both the expected and candidate
  tokens before `timingSafeEqual` — closes the length-leak in the
  previous example
- W-9: sha-256 only in 3.0; sha-512 reserved for a future profile
  version
- W-10: mTLS on webhook ingress SHOULD-consider subsection; the
  client cert MUST be distinct from the signing keypair
- I-3: MUST — `idempotency_key` lookup as an exact byte-string
  (no normalization, Unicode folding, or trimming)
- I-4: MUST — receivers log `WEBHOOK_PAYLOAD_MISMATCH` on body-hash
  divergence under the same key; senders MUST NOT reuse a key for
  semantically different content
- S-11: `identity.compromise_notification` webhook event subsection —
  subscribers MUST invalidate caches, MUST alarm, MUST verify the
  notification with a different `keyid` than the one being revoked

**Authentication (`docs/building/integration/authentication.mdx`)**

- S-1: opening rewritten from "AdCP uses Bearer token authentication"
  to the three-mechanism normative statement — RFC 9421 RECOMMENDED,
  mTLS, Bearer-over-TLS for non-financial operations only

**Registry, governance, and capability surfaces**

- R-2 (`docs/governance/property/adagents.mdx`): prose MUST that
  publishers populate `signing_keys` for mutating-scope agents; the
  verifier MUST reject any `keyid` not in the pinned set regardless
  of what `jwks_uri` advertises
- R-4 (`specs/registry-change-feed.md`): flag feed-carried
  `signing_keys` as `advisory: true, source: cached_from_publisher`;
  verifiers MUST re-fetch from the authoritative origin; the
  registry operator SHOULD content-sign change-feed events as a 4.0
  track item
- R-5 (`docs/registry/index.mdx`): new **Anti-abuse and anti-homograph
  controls** — IDNA 2008 + Unicode confusable-detection SHOULD,
  DNS-TXT or `.well-known/adcp-ownership.txt` ownership proof SHOULD,
  per-org rate limits
- R-8 (`docs/building/understanding/security-model.mdx`):
  multi-principal operators MUST scope keys per-principal via the
  `{operator}:{principal}:{key_version}` `keyid` convention; SHOULD
  advertise `identity.per_principal_key_isolation: true`
- W-4 (`docs/protocol/get_adcp_capabilities.mdx`): new
  `webhook_signing` capability block with `supported`, `profile`,
  `algorithms`, `legacy_hmac_fallback` fields
- W-6 (`static/schemas/source/core/push-notification-config.json`):
  inlined `schemes` enum `["Bearer", "HMAC-SHA256"]` and cross-ref to
  `mcp-webhook-payload`

**Server + compliance tooling**

- I-6 (`server/src/training-agent/idempotency.ts`): exported
  `validateKeyEntropy(key)` — Shannon entropy < 3.5 bits/char
  rejection, unique-char ratio < 0.25, `\d{8,}` monotonic run
  rejection; `validateKeyFormat` untouched
- I-9 (`scripts/build-compliance.cjs`): positive check — any
  deterministic-testing step targeting a mutating tool MUST declare
  `schema_ref`; three pre-existing omissions in
  `static/compliance/source/universal/deterministic-testing.yaml`
  caught and filled
- I-10 (`server/src/training-agent/task-handlers.ts`): destructure-
  and-drop `replayed` before caching; set `body.replayed = true` on
  retrieval as a separate statement from the spread

No test break. `node scripts/build-compliance.cjs` passes.
