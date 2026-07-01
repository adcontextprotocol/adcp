# TMP Router Attestation — Design Proposal

**Status**: proposed as experimental (`trusted_match.router_attestation`); this document is the design rationale, the normative spec lives in `docs/trusted-match/router-attestation.mdx`.
**Target surface**: TMP Router infrastructure (`/.well-known/tmp-router-attestation`, `X-TMP-Attestation` request header, `attestation_requirement` on provider registration), experimental.
**Relates to**: [`docs/trusted-match/router-architecture.mdx`](../docs/trusted-match/router-architecture.mdx), [`docs/trusted-match/privacy-architecture.mdx`](../docs/trusted-match/privacy-architecture.mdx), [`docs/trusted-match/specification.mdx`](../docs/trusted-match/specification.mdx).

This proposal promotes the existing one-paragraph "TEE upgrade path" mention into a normative, experimentally-gated feature with: a `/.well-known/` endpoint, a wire envelope schema, a load-bearing key-to-attestation binding rule, and a per-request `X-TMP-Attestation` carrier so providers can require attestation without going out-of-band. It does **not** ship a verifier kit, a reproducible-build pipeline, KMS provisioning, an `adcp-go` implementation, or conformance scenarios; those land in follow-up bundles. The point of this RFC is to fix the *wire shape* — what an attestation looks like on the wire, what a verifier is allowed to assume, and how a provider declares "I require this" — so the artifacts that follow have a stable contract to target.

## Problem

The router today is the trusted single point in the TMP topology that performs structural separation of context from identity, filters per-provider identity tokens, and re-signs each fan-out forward (`router-architecture.mdx:156`). The privacy guarantee is operationally enforced — the operator deploys the published binary; reviewers audit the source; nothing inspects what is actually running. The current language acknowledges this as a known gap: "Without TEE, you trust that the operator deployed the published binary" (`router-architecture.mdx:51`). The `privacy-architecture.mdx` section "TEE Attestation Details" (line 127-154) sketches what attestation would do — image hash, kernel hash, application hash — but defines no wire shape and no protocol-level invariant.

This matters because the router holds an Ed25519 signing key. The publisher's `agent-signing-key.json` says "this is the public key whose signatures providers MUST accept." But there is no protocol-level evidence that **the private half of that key is held by the attested binary**, rather than by the operator's deployment scripts. A malicious or compelled operator who controls deployment can:

1. Sign the published audited source into a build.
2. Deploy a *modified* binary that produces the same publishable signing-key registration but bridges the context and identity code paths internally.
3. Pass every audit: the signed registration looks correct, every per-provider signature verifies, the only thing that changes is what the binary does between receiving a request and emitting one.

Code audit catches Class 1 (the published source is wrong). TEE attestation closes Class 2 (the deployed binary is not the published source). Both are needed; the protocol currently bakes in the first and waves at the second.

This RFC supplies the wire shape for the second. The decision space is small once it is framed correctly: the verifier needs (a) to know what binary is running, (b) to know what key that binary signs with, and (c) to confirm that the key the protocol already trusts for per-provider signatures **is** the key the binary signs with. Without (c), a publisher could attest a clean binary and then re-sign with a deployment-side key — attestation theater, useful for marketing, useless for the trust gap.

## Framing: attestation as anchor for an existing signature, not a new trust root

The router already produces per-provider Ed25519 signatures over a canonical preimage (`specification.mdx:548`). Those signatures bind the request to a specific provider, seller, and epoch. What they do *not* bind to is the binary that produced them — the signature proves "this preimage was signed by this key," not "this key lives in an attested enclave."

Attestation, framed as a separate trust system, would create a second discovery problem (where does the verifier find the attestation? how does it relate to the signature it already verifies?), a second key-rotation problem, and a second policy surface. Framed as an **anchor** for the existing signature, the contract collapses to one rule:

> The public key in the attestation's user-data slot MUST byte-equal the public key the provider already uses to verify per-provider request signatures.

That one rule — the **binding rule** — is what makes the rest fall into place. The endpoint returns an envelope (`{ document, signing_key, nonce, expires_at }`). The verifier asks the platform-specific kit: "does this document attest a binary that committed to *this* `signing_key` and *this* nonce?" If yes, every subsequent `X-AdCP-Signature` from that key inherits the attestation. If no, the envelope is rejected and the provider falls back to whatever it accepts (which, per its `attestation_requirement` policy, may be "nothing").

This framing keeps the protocol's existing key/signature/epoch machinery as the data-plane mechanism and makes the attestation a low-frequency control-plane attestation of *the key itself* rather than of every request. Per-impression attestation is bandwidth-prohibitive and was considered and rejected (see [Alternatives](#alternatives-considered)).

## Design

### 1. Endpoint

```
GET /.well-known/tmp-router-attestation?nonce=<base64url, 16-32 raw bytes>
```

Public, no auth, no body. Returns a single JSON object matching `/schemas/trusted-match/router-attestation.json`.

**Why `/.well-known/`.** The router already exposes `/healthz`, `/metrics`, and (per the new RFC) needs a stable discovery URL the verifier can probe before sending any traffic. RFC 8615 `/.well-known/` is the right pattern: a single per-host registered path the protocol owns. Splitting attestation into a separate hostname or path layer would force every consumer to learn a second discovery channel; `/.well-known/` reuses the host the verifier is already going to talk to.

**Why GET.** Idempotent, cacheable (with the caveat that caching defeats nonce freshness — the verifier opts out per-fetch by virtue of supplying a fresh nonce). No body to forge or schema-validate on the request side.

**Why query-string nonce.** A verifier MUST supply a fresh value per fetch; in-URL is the simplest place to put it without inventing a POST body just for one query parameter. Length is bounded at 16-32 raw bytes (22-43 base64url-no-pad characters) — 16 bytes is a generic cryptographic-nonce floor (128 bits of entropy, well above birthday-collision risk for any realistic fetch volume); 32 bytes is enough to fold in additional verifier-side context if a kit wants to. Larger is unnecessary; smaller is rejected.

### 2. Wire envelope

```jsonc
{
  "attestation_format": "aws_nitro_cose_sign1_v1",
  "attestation_document": "<base64url(opaque platform document)>",
  "nonce": "<base64url echo of request nonce>",
  "signing_key": { "kty": "OKP", "crv": "Ed25519", "x": "..." , "kid": "router-2026-06" },
  "expires_at": "2026-06-30T18:00:00Z"
}
```

**`attestation_format` is an enum, not a free-form URN.** v1 initial set: `aws_nitro_cose_sign1_v1`, `intel_tdx_quote_v4`, `amd_sev_snp_attestation_v1`, `gcp_confidential_space_v1`. Each names a single externally-defined attestation format and version — the same shape as `enums/feed-format.json`'s `google_merchant_center` / `linkedin_jobs` / `openai_product_feed`. The verifier kit for each format is responsible for parsing the platform document, mapping the envelope's generic `nonce` onto the format-specific user-data slot, and applying any measurement allowlist the deployment cares about. A vendor-neutral URN scheme was considered and rejected (see [Alternatives](#alternatives-considered)).

**`attestation_document` is opaque to AdCP.** This schema neither parses nor validates platform documents. AdCP does not become a downstream of every TEE format's spec churn; verifier kits are versioned per-platform and ship independently. The flip side: receivers without a verifier kit for the declared format MUST reject the envelope as `unsupported_format` rather than falling through.

**`signing_key` is the JWK shape from `/schemas/core/agent-signing-key.json`.** No new JWK schema is invented. The reuse matters because this is *the same key* the provider already verifies request signatures against (`agent-signing-key.json` in the trust anchor). The schema reference makes that explicit at the type level.

**`expires_at` is the router's suggested ceiling.** A verifier MAY enforce a tighter window via `attestation_requirement.min_freshness_sec`. The router's ceiling exists so a consumer that has *no* freshness preference still gets a reasonable cap — without it, a captured envelope is good forever.

**`ext` is the standard escape hatch.** Vendor-namespaced; not for shadowing the binding rule.

### 3. Nonce policy

The verifier MUST:

1. Generate at least 16 bytes of cryptographically random data per verification, never reuse.
2. Encode the bytes as base64url (RFC 4648 §5, unpadded) and place in the `nonce` query parameter.
3. After receiving the envelope, byte-compare `envelope.nonce` against the value it sent. A mismatch is an immediate reject.
4. Confirm that the platform-specific user-data slot of `attestation_document` (e.g., `user_data` for Nitro, `REPORTDATA` for TDX/SEV-SNP) contains the same nonce. This slot-projection rule lives in the verifier kit, not in this schema, because each platform has a different slot name and a different concatenation convention with other user-data components.

The nonce is the freshness signal. The platform document is signed by the platform vendor's root, so a captured-and-replayed document is otherwise indistinguishable from a fresh one. The nonce in the user-data slot is what makes that capture observable.

### 4. Binding rule (load-bearing)

> The JWK in `signing_key` MUST appear bound in the platform user-data slot of `attestation_document` alongside the nonce. Verifiers MUST reject if the bound public key doesn't byte-match the envelope's `signing_key` (after canonical JWK serialization — RFC 7638 thumbprint comparison is acceptable).

This is the rule that makes attestation cryptographically meaningful for the existing `X-AdCP-Signature`/`X-AdCP-Key-Id` per-provider signature path. Without this rule, a router could attest a binary and then sign requests with a different key — the verifier would have no protocol-level way to detect the swap. With this rule:

- The provider already verifies per-provider request signatures against the publisher's trust anchor (`agent-signing-key.json`, fetched per `specification.mdx:601`).
- The provider periodically (or on first contact, or per its `min_freshness_sec` policy) verifies the router's attestation envelope and checks the binding.
- Because the bound key is *the same key* that signs the per-provider requests, every verified per-provider signature inherits the attestation property: "this preimage was signed by a key the attested enclave committed to."

The "no swap" property is the entire reason this RFC exists. It is the bare-minimum cryptographic statement attestation can offer for an existing-signature world, and it is the one statement the wire shape MUST make unambiguous.

How the JWK is rendered into the user-data slot is verifier-kit territory (RFC 7638 thumbprint is the recommended carrier; the platform kit can elect a different canonical form provided it is consistent). The wire envelope carries the JWK directly, not the thumbprint, so the verifier can re-derive the thumbprint and compare. Carrying only the thumbprint would force every consumer to also fetch the JWK from the trust anchor before checking — doubling discovery cost for no security benefit.

### 5. Provider-side opt-in: `attestation_requirement`

Added to `provider-registration.json` (additive, optional):

```jsonc
"attestation_requirement": {
  "required": true,
  "acceptable_formats": ["aws_nitro_cose_sign1_v1", "gcp_confidential_space_v1"],
  "min_freshness_sec": 3600
}
```

When `required: true`, the router MUST attach an `X-TMP-Attestation: <base64url JSON of the envelope>` header to **every** outbound `/context` and `/identity` request to that provider. The provider verifies it on each request (or, sensibly, caches a verified envelope by signing-key thumbprint for the freshness window and only re-verifies on rotation/expiry — the wire spec does not constrain the implementation).

**Why every request, not "once at handshake".** TMP is over HTTP/2 with connection reuse and stateless providers. There is no "session" the provider can pin attestation state onto without inventing one. The per-request header lets the verifier be entirely stateless: it sees an attestation, it caches by `signing_key.kid + thumbprint`, it serves from cache until the freshness budget expires. Per-request is the simplest fit for the existing topology.

**Cost.** Attestation documents are not small. AWS Nitro attestation documents are commonly 4-6 KB; TDX/SEV-SNP quotes are smaller (~1-2 KB); GCP Confidential Space tokens are similar. The envelope adds ~5-10 KB per request to providers with `required: true`. This is operationally significant — TMP messages are otherwise 200-600 bytes (`router-architecture.mdx:112`) — and operators should account for the bandwidth and the parsing cost. Providers that don't need attestation pay nothing (no `attestation_requirement` block, or `required: false`). The per-provider opt-in is the lever that keeps the cost contained.

**Why a header, not a body field.** The body schema is `additionalProperties: false`. Widening it for an out-of-band envelope would conflate request payload with deployment-level proof. Headers are the right HTTP layer for transport-level deployment metadata.

### 6. Caching

Envelope cache discipline mirrors the existing TMP signing-key cache discipline at [`specification.mdx#key-rotation`](../docs/trusted-match/specification.mdx) — the same convention already shared by TMP signing keys and TMPX HPKE encryption keys ("5-minute cache TTL, kid prefix for versioning"). The attestation envelope is, in operational terms, *the same artifact* as the signing key it binds; aligning its cache rules avoids inventing a parallel discipline.

**Concretely:**

- Verifiers cache verified envelopes keyed by the RFC 7638 thumbprint of `signing_key`.
- The cache TTL is `attestation_requirement.min_freshness_sec` (default **300 seconds** — same as the existing signing-key TTL).
- On a `kid` change, the verifier MUST treat the cached envelope as stale and re-fetch eagerly, the same way the existing rule at `specification.mdx:581` already says: "When a signature fails verification, the router SHOULD re-fetch the key before rejecting — the agent may have rotated." The eager re-fetch is what handles rotation inside the freshness window without inventing a separate dual-cache rule.
- Revocation flows through the existing `revoked_at` mechanism on the trust anchor: a revoked signing key is also a revoked envelope, because the envelope's `signing_key` field carries the same `kid` the verifier already looks up against `agent-signing-key.json`.

**Why default 300, not longer.** Attestation document production is more expensive than signing-key fetch (vendor-side cryptographic operations in the enclave, tens of milliseconds), which is an argument for caching longer. But operational alignment with the rest of the protocol's cache discipline is a stronger argument than per-fetch cost — real deployments batch envelope production behind a refresh loop, so the production cost amortizes regardless of TTL choice. Providers that genuinely need a different value can raise `min_freshness_sec` to up to 86400 seconds on their registration; the schema permits it. The default just matches the rest of the protocol.

### 7. No measurement allowlist in the spec

The spec defines what an attestation envelope **is**. It does not define what a verifier should treat as an *acceptable* measurement (e.g., which PCR values constitute "the audited router binary"). That decision is publisher-side / verifier-side deployment policy:

- Different operators publish different builds.
- The "audited binary" reference shifts with each release.
- A reproducible-build artifact registry is a separate, larger project (explicitly out of scope here).

The verifier kit corresponding to `attestation_format` extracts the measurements; what the verifier *does* with them — a local allowlist, a remote registry lookup, a co-signed manifest — is local to that verifier. The spec stops at "here is the envelope; here is the nonce + key binding; the rest is yours."

### 8. Feature gate: `trusted_match.router_attestation`

Declared in `experimental_features` alongside (separate from) `trusted_match.core` and `trusted_match.verified_identity`. Buyers / sellers / providers / routers can support core TMP without committing to attestation. Adding attestation later is purely additive — no existing TMP behavior changes for participants that don't opt in.

The gating language matches verified-identity's: feature gate, opt-in, no silent-experimental. Sellers (and, here, routers and providers) that implement this surface MUST list it in `experimental_features`. A provider whose registration carries `attestation_requirement: { required: true }` is implicitly making this declaration; the experimental gate is the explicit version.

## Security analysis

### What attestation proves (with this design)

- The binary running inside the enclave matches the published, audited source code (assuming the verifier's measurement allowlist resolves to that binary).
- The structurally-separate context and identity code paths in that binary have not been modified by the operator, the hosting provider, or any runtime process.
- **The router's per-provider request signatures are produced by a key the attested binary committed to** — the load-bearing binding rule. A captured signing key cannot be re-used from outside the enclave without breaking the binding check.

### What attestation does not prove

- That buyer agents handle the data they receive responsibly. TMP limits what providers receive; the spec does not control what they do with it.
- That the publisher's join logic — combining context responses with identity responses on the publisher's own infrastructure — is correct. The publisher is the first party and is not constrained by the router's separation model.
- That the published source is free of bugs. Attestation proves the binary matches the published build artifacts. Whether *those* are correct is an open-source audit question, addressed by the existing audit posture in `privacy-architecture.mdx:139-141`.
- That the publisher's measurement allowlist is the right one. A verifier that allowlists a malicious build measurement defeats the entire system; this is a deploy-time, not a wire-time, concern.

### Replay / freshness model

The nonce + `expires_at` + `min_freshness_sec` triad provides:

- **Per-fetch freshness for the envelope itself.** A captured envelope cannot be reused: the verifier-generated nonce is in the user-data slot, and a replay arrives with a stale nonce or wrong user-data slot.
- **A bounded staleness window for per-request reuse.** Once a verifier has verified an envelope, it caches by `signing_key.kid` (+ thumbprint) for at most `min_freshness_sec`. After expiry the verifier re-fetches.
- **No per-impression liveness.** Verifying attestation per request would amortize across roughly the same request stream the existing signatures are amortized over (one Ed25519 verify per provider per epoch via sample-verification, `specification.mdx:575`). Verifying *every* attestation envelope per request would be expensive (~milliseconds for COSE_Sign1 verification + measurement parsing) and bandwidth-prohibitive. The freshness-window cache makes attestation cost-proportional to envelope rotation, not request volume.

### Compromise model

- **Compromised signing key (no enclave attestation):** the operator can sign anything. `X-AdCP-Signature` signatures verify; nothing flags the swap. This is today's posture.
- **Compromised signing key (with enclave attestation, binding rule enforced):** the binding rule is what catches this. The compromised key, if held outside the enclave, signs requests that verify cryptographically but cannot produce an attestation envelope whose user-data slot binds to it (because the enclave that does produce envelopes is bound to a *different* key — the in-enclave key). The provider rejects on `signing_key_not_bound`.
- **Compromised platform vendor root:** outside this RFC's threat model. If the AWS Nitro / Intel TDX / AMD SEV-SNP / GCP Confidential Space root CA is compromised, every attestation in that format is forgeable. This is the floor under all TEE attestation systems and is not improvable at the protocol layer.

### Interaction with key rotation and revocation

Router signing-key rotation already follows `specification.mdx:579-599`: 5-minute cache TTL on `agent-signing-key.json`, new `kid` per rotation, ~48-hour replay window via daily epoch. Attestation must follow the same rotation:

- When the router rotates its signing key, the next envelope binds the new key, and the publisher's trust anchor publishes the new key. Both propagations happen on the same 5-minute TTL.
- Until both have propagated, providers using a cached old-key envelope continue to verify against the old key; once the new key reaches them, the next envelope fetch returns the new key bound in the new attestation document. No re-signing of historical requests is required; the binding rule is per-key, not per-request.

Revocation (`revoked_at` on a key in the trust anchor) interacts the same way: a revoked signing key is *also* a revoked attestation envelope, because the envelope's `signing_key` field carries the same `kid`. Verifiers that see `revoked_at` on the bound key MUST reject the envelope and any signature produced after the revocation.

### Open security topics deferred to the verifier kit

- The exact byte layout of the user-data slot (Nitro `user_data` vs TDX/SEV-SNP `REPORTDATA` vs GCP claim format) and the concatenation convention with other slot fields.
- The on-the-wire form of the JWK-to-slot binding (recommended: RFC 7638 thumbprint, but each verifier kit decides).
- Measurement allowlists / reference values per build.
- Revocation lists for compromised enclave images.

## Alternatives considered

### A. Per-request attestation (no signing-key binding)

Attach the full attestation envelope to every request body. Verifier verifies per-request.

Rejected: bandwidth (~5-10 KB per request × every fan-out × every impression) is prohibitive for a 200-600 byte protocol. Verifier CPU cost (COSE_Sign1 verify + measurement parse per request) blows the 50ms latency budget. And the binding-rule approach gets the same security property — every signature inherits the attestation via key binding — at the cost of one attestation per freshness window.

### B. No nonce, only `expires_at`

Drop the verifier-supplied nonce. Rely solely on the envelope's `expires_at` for freshness.

Rejected: `expires_at` is *the router's* claim about freshness, not a verifier-controlled one. A router producing a fresh envelope on a schedule (every hour) can have its envelope captured and replayed for the rest of that hour against any verifier. The verifier-supplied nonce is the only mechanism that ties the envelope to *this* verifier's *this* fetch, and the only mechanism that distinguishes "freshly produced by an enclave" from "captured from another verifier's recent fetch."

### C. Measurement allowlist in the spec

Define a normative list of acceptable image measurements per `attestation_format`.

Rejected: AdCP would become a downstream of every operator's build pipeline. Reference values shift per release. Different operators run different builds (some operators may even fork the published router). The measurement allowlist is fundamentally a deploy-time, audit-time, publisher-side decision; baking it into the spec creates a perpetual maintenance burden for the working group and a perpetual fight between operators who want their build allowlisted and the WG that owns the list. The verifier kit + publisher-side allowlist is the right factoring.

### D. Vendor-neutral URN scheme for `attestation_format`

Use a URN scheme like `urn:attest:aws:nitro:v1` or `urn:tcg:dice:tdx:v4` instead of a flat enum.

Rejected: enum is the same shape AdCP uses for every other externally-defined-format field (`feed-format.json`, `distribution-identifier-type.json`, `identifier-types.json`). The enum is per-format-version, which already encodes the registry pivot a URN would have provided. URN parsing is extra surface area for no concrete benefit. If a registry-style discoverable identifier becomes important later (a registry of approved attestation formats), the enum can grow into it (each enum value gets a registry entry); this is forward-compatible.

### E. Attestation under `ext.tee` instead of a normative envelope

Treat attestation as a vendor extension under `ext.tee.{nitro,tdx,...}`.

Rejected: the binding rule is normative (it's load-bearing — without it the whole exercise is theater). Normative invariants do not belong under `ext.*` by spec convention (`spec-guidelines.md:288-322`). And there are multiple verifier-kit implementations across multiple buyers; vendor-namespacing makes the cross-implementation contract incoherent.

## Open questions

1. **Revocation list distribution.** Compromised enclave images need to be revoked across the verifier ecosystem. Per-vendor revocation channels (AWS, Intel PCS, AMD KDS, GCP) exist but vary in latency, freshness, and signature format. Whether AdCP should publish a thin aggregator (a `/.well-known/tmp-attestation-revocation`) or punt entirely to verifier-kit responsibility is an open WG decision. Recommendation: punt to verifier kits in v1; revisit if the cross-kit experience proves to be a stumbling block.

2. **Multi-region routers with rotating keys.** A router deployment with N regional instances (e.g., one per PoP, per `router-architecture.mdx:280`) running N distinct signing keys produces N envelopes, all valid for the same publisher. The trust anchor model already accommodates this (multiple keys in `agent-signing-key.json`). The open question is whether a single envelope can attest multiple bound keys (a JWK array under `signing_key`) for one-trip discovery, or whether one-envelope-per-key is the right factoring. Recommendation: one-envelope-per-key in v1; the verifier already fetches per-key on rotation.

3. **Deprecation flow for a format.** When `aws_nitro_cose_sign1_v1` is superseded by `aws_nitro_cose_sign1_v2` (real, hypothetical or otherwise), the enum gains an entry. Providers that allowlist only `v1` reject `v2`; routers that emit only `v2` are unreachable by those providers. The migration window (during which both must be accepted) is operationally complex. v1 spec leaves this to deployment policy and the experimental contract's break-policy; a future RFC may codify a dual-emit envelope shape if the migration pain is real.

4. **Issued-time semantics for `min_freshness_sec`.** The schema says `min_freshness_sec` is the maximum age, but neither `attestation_document` (opaque to AdCP) nor the envelope carries an issuance timestamp in a uniform way. In practice, each platform document exposes issuance via a format-specific field (Nitro `timestamp`, TDX `quote_timestamp`-equivalent, etc.). The wire spec should either carry an explicit `issued_at` at the envelope layer (duplicating across formats) or accept that "age" is verifier-kit-derived. Recommendation: verifier-kit-derived; document the rule per kit, surface the result in a `verified_age_sec` field of the parsed result for higher-layer consumers.

## Non-goals

- **Not a reproducible-build pipeline.** This RFC defines the wire shape of an attestation envelope. It does not define the build system, the source attestation, the SBOM format, or the registry of acceptable measurements. Those are separate (larger) projects.
- **Not a KMS specification.** How the router's signing key is generated, stored, rotated, attested-at-rest, and protected against extraction inside the enclave is out of scope. The protocol cares about the *public* key and the binding; the private-key lifecycle is operator responsibility.
- **Not an `adcp-go` implementation.** Schema and spec only.
- **Not a conformance test bundle.** Verifying that a given verifier kit correctly parses Nitro / TDX / SEV-SNP / GCP documents is conformance territory; this RFC does not define the test vectors.
- **Not a substitute for code audit.** Attestation proves the deployed binary matches a known artifact. Whether *that* artifact is correct is an audit question (`privacy-architecture.mdx:139-141`).
- **Not a privacy enhancement on its own.** The privacy model is already structural (`privacy-architecture.mdx:9`). Attestation is an *integrity* enhancement — it removes the operator from the trust chain for the structural-separation invariant. The privacy properties hold or fail by code; attestation tells you which.
- **Not measurement-allowlist policy.** See Design §6.
- **Not per-impression attestation.** See Alternatives §A.

## Summary

| | No attestation (today) | With router attestation (this RFC) |
|---|---|---|
| Trust root for structural separation | Operator deployed published binary | Enclave attestation, verifiable by the platform vendor root |
| Trust root for per-provider signatures | Key in `agent-signing-key.json` belongs to the deployment | Key in `agent-signing-key.json` is *bound* to the attested binary |
| Per-impression cost | 0 | 0 (binding amortizes via freshness window) |
| Operator can swap signing key without detection | Yes | No (binding rule) |
| Verifier sees binary measurements | No | Yes (via verifier kit) |
| Required to participate in TMP | n/a | No (experimental, opt-in via `trusted_match.router_attestation`) |

The durable protocol contribution is the **binding rule** (Design §4): a one-sentence invariant that turns the existing `X-AdCP-Signature`/`X-AdCP-Key-Id` signature path from "trust the deployed key" into "trust the attested binary that committed to the key." Everything else in the RFC — the endpoint, the envelope, the per-provider opt-in — is the minimum wire shape required to make that binding inspectable.
