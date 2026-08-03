---
"adcontextprotocol": patch
---

Surface relationship trust state in SearchBrandResult and the AgenticAdvertising.org registry API brand list endpoints.

`SearchBrandResult` (the stub returned by `search_brands`) gains three optional fields — `relationship_trust`, `relationship_verified_at`, and `claimed_house_domain` — using the canonical semantics already defined on `ResolvedBrand`. The `house` field becomes optional (brands with no verified or claimed house are no longer required to supply it). Trust values follow the existing enum: `inline | mutual | leaf_only | house_only | standalone | unverifiable`. An absent `relationship_trust` means trust has not yet been computed and MUST NOT be interpreted as `standalone`.

The AgenticAdvertising.org registry API (`/api/brands/registry` and `/api/brands/find`) now returns the same three fields on each brand row. Trust is persisted to the `brands` index table by the crawler after each brand.json resolution cycle, so list endpoints return it without a per-row `resolveBrand()` call at query time. The `BrandRegistryItemSchema` and `CompanySearchResultSchema` Zod schemas are updated to match.
