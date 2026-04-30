---
---

Add Addie tools `parse_brand_properties` and `import_brand_properties` so a brand operator can run the brand-builder smart-paste import from any Addie surface (Slack, web). Both call into the existing `POST /api/brands/:domain/properties/parse` (factored into a new `services/brand-property-parse.ts` shared service) and reuse the same ownership check + DNS 253-char cap, type allowlist, lowercase, and MAX_PROPERTIES (500) defenses. Two-tool preview/commit pattern: `parse_brand_properties` returns the candidate list, `import_brand_properties` merges it into the brand manifest after the user confirms.
