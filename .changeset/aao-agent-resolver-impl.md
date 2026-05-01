---
---

feat(registry): AAO hosted agent resolver — `/api/registry/agents/resolve` and `/api/registry/agents/jwks`

Implements the `/api/registry/agents/resolve` and `/api/registry/agents/jwks`
endpoints described in `specs/capabilities-brand-url.md` §"Hosted resolver
(AAO Registry API)". One-shot resolver runs the full discovery chain
(`get_adcp_capabilities` → `brand_url` → brand.json → `agents[]` entry →
`jwks_uri` → JWKS), enforces the verifier algorithm — eTLD+1 origin
binding with `authorized_operators[]` opt-in, byte-for-byte agents[]
membership, mandatory `identity.key_origins.{purpose}` consistency check,
JWKS `/.well-known/jwks.json` origin default — and surfaces a
privacy-filtered `trace[]` plus `freshness` aggregate so callers can audit
upstream `Cache-Control` without trusting AAO blindly.

The JWKS endpoint propagates upstream `Cache-Control` byte-for-byte (no
extension), keeps the body RFC 7517 pure, and surfaces `X-AAO-Trace-URL`
for audit. `aao_signed: false` is on the wire — this is a convenience
layer, not a trust anchor.

SSRF hardening: HTTPS only, ≤2 KB `agent_url` cap, IPv6 zone-id rejection,
cloud-metadata IP deny list (AWS/GCP/Azure/Alibaba), streamed body cap
(32 KB brand.json, 16 KB JWKS, 64 KB capabilities) with the byte counter
running on the streamed reader rather than `Content-Length`, redirects
disallowed (`maxRedirects: 0`), per-host token-bucket rate limit on
eTLD+1 (10 req/s/host) keyed on a pinned PSL snapshot via `tldts`, plus
the existing per-IP rate limiter middleware on top.

Per round-2 spec, the AAO resolver itself enforces the required-when rule
— `request_signature_key_origin_missing` is returned when signing is
declared without `identity.key_origins.{purpose}` so `mode:"aao"` callers
do not silently lose the H2 protection until 4.0 schema enforcement.
