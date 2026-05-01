# Capabilities → brand.json discovery (`brand_url`)

**Status**: Proposal

**Decision needed**: How does a verifier bootstrap from an agent URL to that agent's signing keys without out-of-band knowledge of the operator domain?

## TL;DR

Add a top-level `brand_url` field to the `get_adcp_capabilities` response. It points to the operator's `brand.json`. brand.json remains the authoritative trust root — capabilities does not carry `jwks_uri`. The verifier chain becomes:

```
agent URL
  → get_adcp_capabilities  (returns brand_url)
  → brand.json
  → agents[] entry whose `url` byte-equals the agent URL
       AND host eTLD+1 matches brand_url eTLD+1
       (or brand.json's authorized_operators[] explicitly delegates the operator domain)
  → jwks_uri  (or `signing_keys` pin from publisher's adagents.json for sell-side webhooks)
  → JWKS
```

Capabilities adds a *pointer to the trust root*, not the keys themselves. The agent never self-attests its keys.

## Problem

Today, given only an agent URL, a verifier cannot find the agent's public keys without prior knowledge of the operator domain. The discovery chain documented in `docs/building/implementation/security.mdx` starts at brand.json — but nothing on the wire tells a fresh verifier *which* brand.json to fetch. Receivers either hard-code operator mappings, rely on `adagents.json` (sell-side only), or trust whatever the agent claims.

The `sponsored_intelligence.brand_url` field already exists for SI agents (`static/schemas/source/protocol/get-adcp-capabilities-response.json:850`) but it is semantically a **rendering** pointer (colors, fonts, logos, tone) — not a trust-root pointer. The two needs happen to resolve to the same artifact today, but they are distinct concepts (an SI agent could legitimately point at a sub-brand brand.json for rendering while still trusting its operator's brand.json for keys). This spec adds a separate top-level pointer for the trust-root role.

## Why not put `jwks_uri` on capabilities directly

A capabilities-hosted `jwks_uri` lets the agent self-attest its own keys. That breaks the trust model: a compromised or impersonating agent can publish keys for itself, and verifiers have no operator-attested anchor to cross-check against. It also creates the conflict surface the user flagged — a `jwks_uri` on capabilities AND a `jwks_uri` in `brand.json agents[]` can disagree, and the spec would need to pick a winner.

There are two operator-attested anchors in AdCP today, with distinct scopes:

- **brand.json** is **operator-attested** ("this agent is mine, here are its keys"). Lives at the operator's domain.
- **adagents.json** is **publisher-attested** ("this agent may sell my inventory; optionally, here is its pinned `signing_keys`"). Lives at the publisher's domain.

For sell-side webhook signatures, the publisher's `adagents.json signing_keys` pin is authoritative over the operator's brand.json `jwks_uri` (`docs/governance/property/adagents.mdx:477`). For request signatures and operator-side webhook signatures, the brand.json `jwks_uri` is authoritative. Either way, the agent does not self-attest. This spec preserves both pins.

## Schema change

Add one field to `static/schemas/source/protocol/get-adcp-capabilities-response.json`:

```jsonc
{
  "brand_url": {
    "type": "string",
    "format": "uri",
    "pattern": "^https://",
    "description": "HTTPS URL of the operator's brand.json (typically https://{operator-domain}/.well-known/brand.json). The agent URL on this response MUST byte-equal the `url` of an entry in that brand.json's `agents[]` array, AND the agent URL's host eTLD+1 MUST equal the brand_url's host eTLD+1 unless the brand.json's `authorized_operators[]` explicitly delegates the agent's eTLD+1 (covers the SaaS-platform-as-operator case where Scope3 runs an agent on behalf of Nike). Verifiers use the matched entry's `jwks_uri` (or its origin default) to discover signing keys. Schema-optional in 3.x; required by storyboard rule when the agent declares any signing posture (see required-when rule below). Becomes schema-required in 4.0. Distinct from `sponsored_intelligence.brand_url`, which is a rendering pointer; sellers populating both MAY set them to different URLs."
  }
}
```

**Required-when rule** (compliance storyboard, not JSON Schema `if/then` — see Open question 1):

- Required if `request_signing.supported_for` or `request_signing.required_for` is non-empty (the agent actually verifies signatures on at least one operation)
- Required if `webhook_signing.supported === true`
- Required if `identity.key_origins` is present (any sub-field)
- **Not** required by `request_signing.supported: true` with empty `supported_for`/`required_for`/`warn_for` — that's a no-op declaration that doesn't bind any operation. Also not required by `identity.compromise_notification` or `identity.per_principal_key_isolation` alone.
- Optional otherwise (read-only browse-only agents that never sign).

**`identity.key_origins` is required when signing.** The schema's existing description treats `key_origins` as advisory. This spec tightens it: when `request_signing.supported_for`/`required_for` is non-empty or `webhook_signing.supported === true`, `identity.key_origins.{purpose}` for the relevant purpose(s) MUST be present. Without it the consistency check (verifier algorithm step 7) is no-op, and the only spoofing defense is the agent-URL-in-brand.json check — which alone is vulnerable to shared-tenancy spoofing. The AAO hosted resolver (below) MUST itself enforce this — returning `consistency.key_origin_match: false` and `request_signature_key_origin_missing` when signing is declared without `key_origins`. Storyboard enforcement alone is insufficient because a verifier in `mode:"aao"` would otherwise silently lose the H2 protection until 4.0 schema enforcement lands.

No `jwks_uri` field is added to capabilities — by design.

## Verifier algorithm

For any signature verification on a request from agent URL `A`:

1. Fetch `A`'s `get_adcp_capabilities` (cached per the existing `last_updated` semantic). On unreachable/timeout, reject with `request_signature_capabilities_unreachable`.
2. Read `brand_url`. If absent and the request is signed, reject with `request_signature_brand_url_missing`.
3. **Origin binding**. The agent URL `A`'s host eTLD+1 MUST equal `brand_url`'s host eTLD+1. If not, fetch brand.json and check that `authorized_operators[]` lists `A`'s eTLD+1. If neither holds, reject with `request_signature_brand_origin_mismatch`. (Public Suffix List for eTLD+1 computation; canonicalize per `docs/reference/url-canonicalization` before extracting the host.)
4. Fetch brand.json at `brand_url` with SSRF validation (HTTPS only, DNS-pin the resolved IP for the request's lifetime, block RFC1918/loopback/link-local/cloud-metadata IPs, body cap 32 KB, redirects disallowed, 5 s connect / 10 s total). Cache TTL bounded by the JWKS revocation polling interval.
5. Find the entry in `agents[]` whose `url` **byte-equals** `A` (matches the existing `security.mdx:552` rule for `iss`-to-brand.json matching; do not canonicalize at this step — a future cross-cutting PR can flip all three resolution paths to canonical at once if desired). If none matches, reject with `request_signature_agent_not_in_brand_json`. If multiple match, reject with `request_signature_brand_json_ambiguous`. (The brand.json schema does not currently constrain `agents[]` to be unique-by-URL; filed as a separate brand.json schema bug — link in Open question 6.)
6. Resolve the JWKS source by purpose:
   - **Sell-side webhook-signing**: the publisher's `adagents.json signing_keys` pin (when present) is the authoritative source per `adagents.mdx:477` and overrides everything below.
   - **All other purposes** (request-signing, operator-side webhook-signing, governance-signing, TMP-signing): use the matched entry's `jwks_uri`, defaulting to `/.well-known/jwks.json` at the origin of `A` when absent (existing rule, `static/schemas/source/brand.json:631`).
7. **Consistency check (mandatory when signing).** For every `purpose` declared under `identity.key_origins` on the capabilities response **whose JWKS source in step 6 was the operator brand.json** (i.e., not a publisher `adagents.json signing_keys` pin), the host of the resolved `jwks_uri` MUST equal the declared origin for that purpose. Mismatch on any purpose → reject with `request_signature_key_origin_mismatch` carrying `{ purpose, expected_origin, actual_origin }`. Skip the check for purposes whose source was a publisher pin — the pin is a publisher's intentional override and may legitimately point at a different host than the operator's `key_origins` declaration.
8. Fetch JWKS, find the `kid`, verify per the existing RFC 9421 profile.

## Multi-tenant operators

An agent has exactly one `brand_url` — pointing to its **operator's** brand.json. Per-advertiser identity (an agency running on behalf of multiple advertisers) rides on **per-principal keys**, not on multiple `brand_url` values. The flow:

- The agency is the operator. Its brand.json `agents[]` lists the agent endpoint(s) it runs.
- For per-advertiser key isolation, the operator declares `identity.per_principal_key_isolation: true` on capabilities and scopes signing keys per-principal in the JWKS (existing schema, response:1017–1021).
- The agency's brand.json MAY declare `authorized_operators[]` granting other domains permission to operate on its behalf (existing schema, brand.json:663).
- For the SaaS-platform case (Scope3 runs an agent at `agent.scope3.com/mcp` on behalf of Nike, whose brand.json is at `nike.com`): Nike's brand.json `agents[]` lists `agent.scope3.com/mcp`, and Nike's `authorized_operators[]` lists `scope3.com`. The verifier algorithm step 3 accepts the cross-domain agent because of the explicit delegation.

This keeps "one agent → one brand.json" without forcing per-advertiser endpoint proliferation.

## What stays the same

- `adagents.json signing_keys` precedence is unchanged: publisher pin > operator brand.json `jwks_uri` for sell-side webhooks.
- brand.json schema is unchanged. Existing `agents[].jwks_uri` and the `/.well-known/jwks.json` origin default are unchanged.
- Webhook-signing key publication is unchanged (`security.mdx:1176`).
- `sponsored_intelligence.brand_url` is **kept**, not deprecated. It serves a distinct rendering role and may resolve to a different URL than the trust-root `brand_url`.

## Migration

3.x:
- Add `brand_url` as optional in the next release. Document the required-when rule. No verifier breakage — verifiers that don't use it behave as today.
- `sponsored_intelligence.brand_url` continues to mean "rendering pointer" — unchanged.

4.0:
- `brand_url` becomes required for any agent that signs (matches the 4.0 stance that signing is required for spend-committing operations).
- `identity.key_origins.{purpose}` becomes required whenever the corresponding signing posture is supported (lifts the soft-required-when from 3.x storyboard rule to schema-required).

## Error codes

New rejection reasons, joining the existing `request_signature_*` family (`security.mdx:1125`). Webhook-signature variants use `webhook_signature_*` mirrors:

| Code | When | Detail fields |
|------|------|---------------|
| `request_signature_brand_url_missing` | Capabilities did not carry `brand_url` and a signed request was received | `agent_url` |
| `request_signature_capabilities_unreachable` | Capabilities fetch failed | `agent_url`, `http_status`, `dns_error`, `last_attempt_at` |
| `request_signature_brand_json_unreachable` | brand.json fetch failed | `brand_url`, `http_status`, `dns_error`, `last_attempt_at` |
| `request_signature_brand_origin_mismatch` | Agent eTLD+1 ≠ brand_url eTLD+1 and `authorized_operators[]` does not delegate | `agent_url`, `agent_etld1`, `brand_url_etld1` |
| `request_signature_agent_not_in_brand_json` | Agent URL not present in `agents[]` of resolved brand.json | `agent_url`, `brand_url` |
| `request_signature_brand_json_ambiguous` | Multiple `agents[]` entries match the agent URL | `agent_url`, `brand_url`, `matched_count`, `matched_entries[]` (URL + id) |
| `request_signature_key_origin_mismatch` | `jwks_uri` host ≠ declared `identity.key_origins.{purpose}` | `purpose`, `expected_origin`, `actual_origin` |
| `request_signature_key_origin_missing` | Signing posture declared but `identity.key_origins.{purpose}` absent | `purpose`, `posture` |

Detail fields surface in error responses so operators can fix the misconfiguration without log archaeology.

## Compliance impact

New universal storyboard: `capabilities-brand-url-discovery`. Variants:
- Capabilities returns `brand_url`; brand.json contains the agent; eTLD+1 matches; `key_origins` matches; verifier resolves keys end-to-end. Expected: pass.
- Capabilities omits `brand_url` while declaring `request_signing.supported: true`. Expected: storyboard fails the agent.
- Capabilities returns a `brand_url` whose brand.json does NOT list the agent. Expected: verifier rejects with `request_signature_agent_not_in_brand_json`.
- Capabilities `brand_url` host is on a different eTLD+1 than the agent URL, with no `authorized_operators[]` delegation. Expected: verifier rejects with `request_signature_brand_origin_mismatch`.
- Capabilities declares `identity.key_origins.request_signing` whose host disagrees with the resolved `jwks_uri` host. Expected: verifier rejects with `request_signature_key_origin_mismatch`.
- Capabilities omits `identity.key_origins.request_signing` while declaring `request_signing.supported: true`. Expected: storyboard fails the agent.

The required-when rules land as storyboard assertions regardless of whether they're encoded in JSON Schema (Open question 1).

## Hosted resolver (AAO Registry API)

The native chain — capabilities → brand.json → agents[] → jwks_uri → JWKS — is correct, but it's five HTTP calls and several validation steps. AAO publishes a public, unauthenticated reference implementation alongside the existing registry surface (`docs/registry/index.mdx`) so callers can do this in one HTTP call.

**Trust posture (read this first).** The hosted resolver is a **convenience layer, not a trust anchor.** AAO does not sign resolution responses. Production verifiers handling spend-committing operations MUST use native resolution (`mode: "native"` in the SDK helpers) and treat AAO as a fallback or a discovery hint, not as the authoritative source. Callers who delegate trust to AAO are accepting AAO as part of their verification chain — including BGP, CA, and operational-compromise risks. The reference implementation is open-source and self-hostable; AAO's instance is one option, not the only option. This is the same posture as the registry change feed (advisory identity material — see `docs/registry/index.mdx` §Anti-abuse).

### `GET /api/registry/agents/resolve`

One-shot resolver. Caller passes an agent URL, gets the full discovery chain and the verifier inputs in one response. Implements the verifier algorithm above and surfaces both the inputs and the consistency-check verdict.

```bash
curl "https://agenticadvertising.org/api/registry/agents/resolve?agent_url=https://buyer.example.com/mcp"
```

Response (200 OK):

```jsonc
{
  "agent_url": "https://buyer.example.com/mcp",
  "brand_url": "https://example.com/.well-known/brand.json",
  "operator_domain": "example.com",
  "agent_entry": {
    "type": "buying",
    "url": "https://buyer.example.com/mcp",
    "id": "buyer_main",
    "jwks_uri": "https://keys.example.com/.well-known/jwks.json"
  },
  "jwks_uri": "https://keys.example.com/.well-known/jwks.json",
  "jwks": {
    "keys": [
      {
        "kty": "OKP", "crv": "Ed25519",
        "x": "SRYr8eSvjkZF6dAUquI1sKuU4YGZkoGH-2jwkz4dRJg",
        "kid": "buyer-signing-2026-04",
        "alg": "EdDSA", "use": "sig",
        "adcp_use": "request-signing",
        "key_ops": ["verify"]
      }
    ]
  },
  "signing_keys_pin": null,
  "identity_posture": {
    "per_principal_key_isolation": true,
    "key_origins": {
      "request_signing": "https://keys.example.com",
      "webhook_signing": "https://keys.example.com"
    }
  },
  "consistency": {
    "origin_binding": "etld1_match",
    "key_origin_match": true,
    "issues": []
  },
  "aao_signed": false,
  "resolved_at": "2026-04-30T12:00:00Z",
  "upstream_fetched_at": "2026-04-30T12:00:00Z",
  "cache_until": "2026-04-30T12:05:00Z",
  "source": "live"
}
```

Error responses use the same error codes as the verifier algorithm (with their detail fields). `aao_signed: false` is on the wire, not just in docs, to make non-attestation explicit.

`source` ∈ `{"live", "cached"}`. **No `"stale"` mode for resolutions that include `jwks`** — a rotated-out compromised key MUST NOT be served past its TTL. `cache_until` is advisory; production verifiers MUST use the standard `Cache-Control` header and ignore `cache_until` for trust decisions. `X-AAO-Resolver-Age` header surfaces server-asserted age so callers can enforce their own staleness floor. `X-AAO-Upstream-JWKS-URI` header carries the upstream URL so verifiers can cross-check.

### `GET /api/registry/agents/jwks`

Drop-in JWKS endpoint. Returns the resolved JWKS in standard RFC 7517 form so existing JOSE libraries (`jose`, `pyjwt`, `nimbus-jose-jwt`) work without any AdCP-aware code.

```bash
curl "https://agenticadvertising.org/api/registry/agents/jwks?agent_url=https://buyer.example.com/mcp"
```

Response (200 OK, `Content-Type: application/jwk-set+json`):

```jsonc
{
  "keys": [
    {
      "kty": "OKP", "crv": "Ed25519",
      "x": "SRYr8eSvjkZF6dAUquI1sKuU4YGZkoGH-2jwkz4dRJg",
      "kid": "buyer-signing-2026-04",
      "alg": "EdDSA", "use": "sig",
      "adcp_use": "request-signing",
      "key_ops": ["verify"]
    }
  ]
}
```

Every signing JWK MUST carry the AdCP-required four-tuple per `security.mdx:780`: `kid` (unique across the JWKS), `use: "sig"`, `key_ops: ["verify"]`, and `adcp_use` (one of `request-signing`, `webhook-signing`, `governance-signing`, `tmp-signing`). Plus `alg` per the algorithm allowlist (`EdDSA`, `ES256`). Verifiers MUST enforce all four. The endpoint propagates upstream `Cache-Control` byte-for-byte and never extends TTLs — a rotated-out key disappears on the operator's TTL, not AAO's. Served from a separate hostname (`jwks.agenticadvertising.org`, HSTS-preloaded, CAA-pinned) so a compromise of the main hostname does not contaminate the key resolution path. The `X-AAO-Trace-URL` response header points at `/api/registry/agents/resolve?agent_url=...` so JOSE callers (whose body must remain RFC 7517 pure) can still surface the audit trail.

### Caller integration

**Native (production-recommended, no third-party in the trust chain):**

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import { resolveAgentBrandJson } from "@adcp/client";

// Native resolution: capabilities → brand.json → agents[] entry → jwks_uri
const { jwksUri } = await resolveAgentBrandJson(agentUrl, { mode: "native" });

const jwks = createRemoteJWKSet(new URL(jwksUri), {
  cacheMaxAge: 5 * 60 * 1000,    // 5 min
  cooldownDuration: 30 * 1000,   // 30 s
});

const { payload } = await jwtVerify(token, jwks, {
  algorithms: ["EdDSA", "ES256"],   // AdCP request-signing profile
  issuer: agentUrl,
});
```

**AAO-resolver (convenience, opt-in trust delegation):**

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const aao = "https://jwks.agenticadvertising.org/api/registry/agents/jwks";
const jwks = createRemoteJWKSet(
  new URL(`${aao}?agent_url=${encodeURIComponent(agentUrl)}`),
  { cacheMaxAge: 5 * 60 * 1000, cooldownDuration: 30 * 1000 },
);

const { payload } = await jwtVerify(token, jwks, {
  algorithms: ["EdDSA", "ES256"],
  issuer: agentUrl,
});
```

The native form is shown first deliberately. Most production integrators should ship that.

### SDK helpers

`@adcp/client`:

```ts
// Native: capabilities → brand.json → JWKS. No AAO dependency.
function resolveAgentBrandJson(
  agentUrl: string,
  opts?: { fetch?: typeof fetch; cacheTTLs?: { brandJson?: number; jwks?: number } },
): Promise<{ brandUrl: string; agentEntry: BrandAgentEntry; jwksUri: string; jwks: JWKSet }>;

// AAO convenience.
function resolveAgentViaAAO(
  agentUrl: string,
  opts?: { aaoBase?: string; fetch?: typeof fetch },
): Promise<AAOResolveResponse>;

// JOSE adapter — returns the thing jwtVerify wants.
function createAgentJWKSet(
  agentUrl: string,
  opts: { mode: "native" | "aao"; allowedAlgs: string[]; cacheMaxAge?: number },
): JWTVerifyGetKey;
```

Python (`adcp`):

```python
def resolve_agent_brand_json(
    agent_url: str, *, mode: Literal["native", "aao"] = "native",
) -> AgentBrandResolution: ...

def verify_request_signature(
    request: httpx.Request, *,
    agent_url: str,
    mode: Literal["native", "aao"] = "native",
    allowed_algs: tuple[str, ...] = ("EdDSA",),
) -> VerifiedIdentity: ...
```

`mode="native"` is the default in both SDKs. Flipping to `"aao"` is an explicit opt-in to delegating trust.

### SSRF and rate-limit hardening

The hosted resolver is a centralized fetcher of caller-controlled URLs. Hardening is mandatory in the reference implementation. Implementers MUST cover this list before deployment:

- HTTPS only.
- Reject `agent_url` query strings exceeding 2 KB before any fetch.
- DNS resolution: filter by address family **before** DNS-pinning (DNS rebinding defense; pin the resolved IP for the request's lifetime). Block, with explicit test coverage:
  - IPv4: RFC 1918 private (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16), CGNAT (100.64/10), `0.0.0.0`, `255.255.255.255`, multicast (224/4), reserved (240/4).
  - IPv6: loopback (`::1`), link-local (`fe80::/10`), unique-local (`fc00::/7`), IPv4-mapped (`::ffff:0:0/96`), multicast (`ff00::/8`), unspecified (`::`).
  - Cloud metadata: `169.254.169.254` (AWS, GCP, Azure), `fd00:ec2::254` (AWS IPv6), `100.100.100.200` (Alibaba). Maintain an explicit deny list — do not rely on link-local block alone.
- Bracketed-IPv6 URL parsing: zone-ID stripping (`%25`) and unbracketed forms. Use a parser with explicit RFC 6874 handling; reject unparseable hosts.
- Body cap (streamed reader with byte counter, not just `Content-Length` check): 32 KB for brand.json, 16 KB for JWKS, 64 KB for capabilities response.
- Connect timeout 5 s; total deadline 10 s. Per-stage deadline 4 s.
- Redirects disallowed (`maxRedirects: 0`). If a future mode allows them, cap at 1 same-origin and re-run the address-family + IP-block filter on the redirect target.
- Per-upstream-host rate limit, default 10 req/s/host keyed on eTLD+1 (resolver MUST NOT amplify traffic to operator domains beyond a configurable cap).
- Per-caller-IP rate limit MUST be lower than the per-upstream-host cap so a single caller cannot exhaust an operator's quota.
- Public Suffix List for eTLD+1 computation MUST be a pinned, dated snapshot bumped via dependency update — not a runtime fetch.
- Error-response detail fields HTML-escaped before reflection (header injection / log poisoning hardening). Canonicalize `agent_url` and length-cap before logging.

### Trace / freshness on the resolve endpoint

The `/api/registry/agents/resolve` response includes a top-level `trace[]` array — one entry per upstream HTTP call (capabilities → brand.json → JWKS) — plus a top-level `freshness` aggregate. A human integrator (or coding agent) hitting the endpoint can audit "is this up to date?" in one glance without trusting AAO blindly.

```jsonc
{
  // ... agent_url, brand_url, jwks_uri, jwks, consistency, aao_signed, etc. as above ...
  "freshness": "fresh",
  "trace": [
    { "step": "capabilities",
      "url": "https://buyer.example.com/mcp",
      "method": "MCP_CALL",
      "status": 200,
      "etag": null,
      "last_modified": null,
      "cache_control": null,
      "fetched_at": "2026-04-30T12:00:00Z",
      "age_seconds": 0,
      "bytes": 4821,
      "from_cache": false,
      "ok": true },
    { "step": "brand_json",
      "url": "https://example.com/.well-known/brand.json",
      "method": "GET",
      "status": 200,
      "etag": "\"b9f0\"",
      "last_modified": "Wed, 29 Apr 2026 18:00:00 GMT",
      "cache_control": "max-age=300, public",
      "fetched_at": "2026-04-30T12:00:00Z",
      "age_seconds": 0,
      "bytes": 1903,
      "from_cache": false,
      "ok": true },
    { "step": "jwks",
      "url": "https://keys.example.com/.well-known/jwks.json",
      "method": "GET",
      "status": 200,
      "etag": null,
      "last_modified": null,
      "cache_control": "max-age=300",
      "fetched_at": "2026-04-30T12:00:00Z",
      "age_seconds": 0,
      "bytes": 612,
      "from_cache": false,
      "ok": true }
  ]
}
```

`freshness` ∈ `{"fresh", "stale", "unknown"}`:
- `fresh` — every step's `age_seconds` ≤ its declared TTL.
- `stale` — at least one step exceeds its declared TTL (resolver still returned because cache was valid, but caller may want to force-refresh).
- `unknown` — at least one step lacked cache metadata (no `Cache-Control`, no `Last-Modified`).

Per-step fields are **observed upstream metadata** — AAO does not attest to their accuracy. Verifiers MUST NOT use `trace` fields as a substitute for fetching `Cache-Control` themselves.

**On failure**, the trace renders up to the failed step (marked `ok: false` with the matching `request_signature_*` error code in `error.code`); subsequent steps are absent (not nulled). A 502 response carries the same body shape so jq pipelines work consistently across success and failure.

**Privacy**: query strings stripped from `url`; resolved IPs never echoed; redirect chains never echoed (redirects are disallowed); request headers never echoed; response headers limited to `etag`, `last_modified`, `cache_control`, `bytes` (`Content-Length`-derived); all string fields HTML-escaped before reflection.

The `/api/registry/agents/jwks` endpoint omits the trace from its body (which must remain RFC 7517 pure for JOSE-library compatibility) and surfaces `X-AAO-Trace-URL: https://agenticadvertising.org/api/registry/agents/resolve?agent_url=...` so callers can fetch the human-readable audit trail when needed.

CLI usage:

```bash
curl -s "https://agenticadvertising.org/api/registry/agents/resolve?agent_url=https://buyer.example.com/mcp" \
  | jq '{freshness, trace: [.trace[] | {step, status, age: .age_seconds, fetched_at, ok}]}'
```

Output:

```json
{
  "freshness": "fresh",
  "trace": [
    { "step": "capabilities", "status": 200, "age": 0,   "fetched_at": "2026-04-30T12:00:00Z", "ok": true },
    { "step": "brand_json",   "status": 200, "age": 12,  "fetched_at": "2026-04-30T11:59:48Z", "ok": true },
    { "step": "jwks",         "status": 200, "age": 287, "fetched_at": "2026-04-30T11:55:13Z", "ok": true }
  ]
}
```

### Where this lives in `docs/registry/index.mdx`

Add to the Lookups & Authorization table:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/registry/agents/resolve` | Resolve an agent URL to its operator brand.json, JWKS URI, and JWKS. One-shot for signature verification. |
| GET | `/api/registry/agents/jwks` | JWKS for an agent URL, in standard RFC 7517 form. Drop-in for any JOSE library. |

Public, unauthenticated, rate-limited per the existing non-bulk endpoint conventions (60 req/min/IP for resolve, 60 req/min/IP for jwks, plus the per-upstream-host cap above).

## Open questions

1. **Schema enforcement of required-when**. JSON Schema draft-07 `if/then/else` is dropped by several code generators (same constraint that drove the discriminated union on `idempotency`). Lean toward keeping the required-when rules in compliance storyboards and 4.0 schema-required, not in 3.x JSON Schema.
2. **Caching coordination**. brand.json fetch TTL needs to align with the JWKS refetch cooldown (existing 30 s rule, `security.mdx:956`). Recommend brand.json TTL ≥ JWKS TTL so a key rotation doesn't require a brand.json invalidation. Document in `security.mdx` alongside the JWKS cache rules.
3. **TLS-trust hardening**. brand.json fetch is plain HTTPS GET. With `brand_url` becoming the universal trust pointer, a CA mis-issuance against the operator domain gives an attacker the keys to every signing agent that operator runs. Recommend operators publish brand.json at a host with CAA records pinning their issuer; verifiers SHOULD consult CT logs on first fetch. Document in `security.mdx`.
4. **Signed resolver responses**. Should the AAO hosted resolver sign its responses (JWS over the resolution result) so paranoid verifiers can use it offline-auditable? OIDC-style precedent says yes. Defer to a follow-up if the resolver sees real production usage.
5. **Bulk resolver endpoint**. Dropped from v1 (per ad-tech product feedback — premature without demonstrated demand). Native resolution + per-agent caching covers the buy-side fan-out case; revisit if cold-cache traffic patterns prove the need.
6. **Cross-protocol uniformity of URL matching**. brand.json schema currently says "canonicalize" for matching agent URLs (`brand.json:614`); `security.mdx:552` says "byte-for-byte". This spec uses byte-for-byte to match `security.mdx`. A future cross-cutting PR should pick one and align all three resolution paths (this spec, brand.json schema, security.mdx) — out of scope here.

## Rollout

- PR 1: Schema + docs. Add `brand_url` to capabilities response schema; update `security.mdx` discovery chain; add the eTLD+1 origin-binding rule and the consistency-check note alongside `identity.key_origins`; document the trust-posture distinction between brand.json (operator) and adagents.json (publisher).
- PR 2: Storyboard. Add `capabilities-brand-url-discovery` to universal compliance with all six variants from §Compliance impact.
- PR 3: Verifier reference implementation in `@adcp/client` and the Python SDK. Add the new `request_signature_*` error codes to the existing rejection table. SDK helpers default to `mode="native"`.
- PR 4: AAO hosted resolver as a self-hostable reference implementation. Implement `/api/registry/agents/resolve`, `/api/registry/agents/jwks` (separate hostname), SSRF hardening, no stale JWKS. Document in `docs/registry/index.mdx` and add to OpenAPI spec at `static/openapi/registry.yaml`. Wire to existing brand.json + JWKS fetch infrastructure.
- PR 5 (4.0 cycle): Flip `brand_url` and `identity.key_origins` required-when from advisory storyboard rule to JSON-Schema-required.

## Reviewer feedback addressed

- **Security H1 (shared-tenancy spoofing)**: added eTLD+1 origin binding between agent URL and `brand_url` host, with `authorized_operators[]` opt-in for the SaaS-platform-as-operator case (verifier algorithm step 3, error `request_signature_brand_origin_mismatch`).
- **Security H2 (`key_origin_mismatch` optional)**: made `identity.key_origins.{purpose}` mandatory whenever the corresponding signing posture is supported, and the consistency check mandatory for every declared purpose (verifier algorithm step 7).
- **Security M1 (SSRF)**: explicit hardening list for the AAO resolver — HTTPS, DNS pin, RFC1918 block, body caps, redirect cap, per-host rate limit.
- **Security M2 (stale-while-revalidate on JWKS)**: dropped — JWKS endpoint propagates upstream `Cache-Control` byte-for-byte and never extends TTLs.
- **Security M3 (JOSE compatibility silently inducts AAO)**: separate hostname for the JWKS endpoint; `aao_signed: false` and `X-AAO-Upstream-JWKS-URI` on the wire; native example shown first; SDK defaults to `mode="native"`.
- **Security M4 (TLS trust)**: open question 3 added; CAA-pinning recommendation deferred to docs.
- **Protocol (byte-for-byte vs canonicalization)**: byte-for-byte matching to align with `security.mdx:552`; cross-cutting alignment deferred (open question 6).
- **Protocol (operator vs publisher attestation conflated)**: rewrote §Why not put `jwks_uri` on capabilities directly to draw the distinction explicitly.
- **Protocol (required-when too broad)**: tightened to `request_signing.supported || webhook_signing.supported || identity.key_origins present` — drops the "any identity field" trigger.
- **Protocol (error-code naming)**: prefixed with `request_signature_*` to join the existing family.
- **Protocol (cross-protocol coverage gap)**: consistency check is purpose-generic — covers `webhook_signing`, `governance_signing`, `tmp_signing` not just request-signing.
- **Protocol (SI brand_url deprecation)**: reverted — kept as a distinct rendering pointer.
- **Product (multi-tenant agencies)**: explicit §Multi-tenant operators section — agent's `brand_url` = operator; per-advertiser identity rides on per-principal keys; `authorized_operators[]` covers the SaaS-platform case.
- **Product (AAO as SPOF)**: reframed AAO resolver as a self-hostable reference implementation; trust posture moved to the top of the §Hosted resolver section; native example first in caller integration.
- **Product (bulk endpoint premature)**: dropped from v1 (open question 5).
- **DX (JOSE example gotchas)**: native example shown first with explicit `algorithms`, `cacheMaxAge`, `cooldownDuration`, `issuer`; `kid` required on every JWK in resolver responses.
- **DX (error-code actionability)**: detail fields tabulated (`http_status`, `dns_error`, `last_attempt_at`, `purpose`, `matched_entries[]`, eTLD+1 specifics).
- **DX (`source: stale`)**: dropped for JWKS-bearing responses; `upstream_fetched_at` and `X-AAO-Resolver-Age` surface freshness.
- **DX (SDK helpers)**: signatures sketched; `mode="native"` default.
- **DX (`.well-known/adcp-jwks.json` shortcut)**: dropped after round 2 — re-introduced M3-prime self-attestation without saving fetches on the trust-required path. JOSE callers get the trace via `X-AAO-Trace-URL` header pointing at the resolve endpoint.

### Round 2 (after the spec was rewritten)

- **Protocol (`key_ops` MUST NOT)**: reverted — `security.mdx:780` requires the AdCP four-tuple (`use:"sig"`, `key_ops:["verify"]`, `adcp_use`, distinct `kid`). JWK examples now match the canonical shape from `security.mdx:840-850`. Removing `key_ops` would have invalidated every conformant signing JWK in the codebase and the test vectors at `static/compliance/source/test-vectors/request-signing/`.
- **Protocol (required-when on `supported` is wrong cut)**: tightened to `supported_for[]`/`required_for[]` non-empty for `request_signing` (a no-op declaration with empty arrays doesn't bind any operation, so it shouldn't drag in `key_origins`). `webhook_signing.supported === true` cut unchanged.
- **Protocol (consistency check breaks sell-side webhooks)**: step 7 now skips the origin check for purposes whose JWKS source was a publisher `adagents.json signing_keys` pin — the pin is an intentional override and may legitimately point at a different host than the operator's `key_origins` declaration. Operator-side purposes still enforced.
- **Protocol (loose SHOULDs)**: tightened to MUSTs at lines 143 (production verifiers MUST use native), 195 (verifiers MUST honor upstream `Cache-Control`), and the trust-posture paragraph.
- **Security (PSL pinning)**: SSRF hardening now requires a pinned, dated PSL snapshot, not a runtime fetch.
- **Security (IPv6 ULA + cloud metadata)**: SSRF list expanded with explicit IPv6 unique-local, IPv4-mapped IPv6, multicast, AWS/GCP/Azure metadata IPs, bracketed-IPv6 zone-ID handling.
- **Security (DNS rebinding ordering)**: address-family filter MUST run before DNS-pin.
- **Security (per-caller < per-host rate cap)**: explicit invariant added so a single caller cannot exhaust an operator's quota.
- **Security (AAO must enforce required-when at runtime)**: AAO resolver itself returns `request_signature_key_origin_missing` when signing is declared without `key_origins` — storyboard alone is insufficient because `mode:"aao"` callers would lose H2 protection until 4.0.
- **DX (full-path breadcrumb)**: added `trace[]` array + `freshness` aggregate to `/resolve` response. Per-step fields: `step`, `url`, `method`, `status`, `etag`, `last_modified`, `cache_control`, `fetched_at`, `age_seconds`, `bytes`, `from_cache`, `ok`, `error`. JWKS endpoint surfaces `X-AAO-Trace-URL` header pointing at the resolve endpoint (preserves RFC 7517 purity in the body).
- **DX (failure breadcrumbs render up to the failed step)**: 502 response carries the same body shape; failed step marked `ok: false` with the matching `request_signature_*` error code.
- **DX (privacy filters on trace)**: query strings stripped, IPs not echoed, redirect chains not echoed (disallowed anyway), HTML-escaped reflection.
