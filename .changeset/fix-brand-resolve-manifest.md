---
---

Fix `/api/brands/resolve` returning empty `brand_manifest` for house-portfolio brand.json files.

`BrandManager.resolveBrand` and `resolveBrandRef` were reading a nested `brand.brand_manifest` field that no longer exists in the brand.json schema — brand fields (logos, colors, fonts, tone, description, properties, etc.) have been flat on the brand object since the unified brand identity refactor. The master-brand fallback (when the queried domain matches the house domain) also omitted the manifest entirely.

All three return sites now build `brand_manifest` from the brand object minus identity fields (`id`, `names`, `keller_type`, `parent_brand`). Legacy nested `brand_manifest` sub-keys are merged in for backwards compatibility.
