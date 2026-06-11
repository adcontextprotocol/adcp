---
"adcontextprotocol": minor
---

schema(brand): raise brand.json `agents[]` maxItems 20 → 200 for multi-tenant operators, and reconcile the JWKS size budget

The per-tenant JWKS pattern blessed in #5458 is one `agents[]` entry per tenant, but the `maxItems: 20` cap made a >20-tenant `brand.json` schema-invalid — below the scale the multi-tenant case is actually about. Raises the cap to 200 (additive and non-breaking — loosening a `maxItems` never invalidates an existing valid document).

Also reconciles the two JWKS size figures in L1 security so a conservative verifier can't reject a conformant shard: the 64 KiB `MAX_JWKS_BYTES` is the JWKS-specific budget (deliberately tighter than the generic 5 MB SSRF body ceiling), and per-tenant `jwks_uri` sharding is the conformant path above it — for size as well as key isolation. Closes #5445.
