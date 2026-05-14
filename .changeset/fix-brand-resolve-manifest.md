---
---

Fix `/api/brands/resolve` returning empty `brand_manifest` for house-portfolio brand.json files.

`BrandManager.resolveBrand` and `resolveBrandRef` were reading a nested `brand.brand_manifest` field that no longer exists in the brand.json schema — brand fields (logos, colors, fonts, tone, description, properties, etc.) have been flat on the brand object since the unified brand identity refactor. The master-brand fallback (when the queried domain matches the house domain) also omitted the manifest entirely.

All three return sites now build `brand_manifest` from the brand object via a new `buildBrandManifest` helper. Identity fields (`id`, `names`, `keller_type`, `parent_brand`) and ownership data (`properties`) are stripped; remaining flat fields become the manifest payload. Legacy nested `brand_manifest` sub-keys are merged in for backwards compatibility, with flat fields taking precedence.

**Behavior note for `brand_manifest` consumers:** `properties` (digital touchpoints the brand owns) is intentionally excluded from `brand_manifest` even though it lives on the brand object. The manifest is the brand's creative-asset payload (logos, colors, fonts, tone) — consistent with how downstream code (`services/brand-enrichment.ts`) already treats it. Callers needing ownership data should read `brand.properties` directly.

**Type model:** `BrandDefinition` and `BrandProperty` in `server/src/types.ts` are now derived from the canonical `BrandJson` zod schema in `@adcp/sdk` (>= 7.3.0) rather than hand-maintained. Future brand.json schema changes regenerate the SDK type and flow through automatically — preventing the staleness class that caused this bug. Required SDK bump from `^7.1.0` to `^7.3.0`.
