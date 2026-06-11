---
"adcontextprotocol": minor
---

spec: allow multi-tenant seller-agent operators to publish more than 20 `brand.json` `agents[]` entries and clarify per-tenant JWKS resolution.

`brand.json` no longer caps `agents[]` at 20 entries, allowing one same-type sales-agent entry per tenant or property-scoped endpoint. The seller setup guidance now documents the A1 static-shard pattern: verifiers resolve keys from the authenticated agent URL to exactly one `agents[].url` entry, use that entry's `jwks_uri` or the default origin JWKS, and reject duplicate matching entries as ambiguous rather than selecting by agent `type` or request-payload tenant fields.
