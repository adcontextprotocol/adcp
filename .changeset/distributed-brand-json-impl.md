---
"adcontextprotocol": minor
---

`brand.json` gains a fifth variant and distributed publishing model. Additive — existing publishers unchanged.

**New variant — Brand Canonical Document.** A self-published per-brand document carrying the brand's identity attributes plus optional `house_domain` (string, the domain of the brand's parent house). Standalone brands (no parent house — Patagonia, Liquid Death) omit `house_domain`. Excludes top-level house-only fields (`house`, `brands`, `brand_refs`, `authorized_operators`) to disambiguate from House Portfolio.

**House Portfolio additions.** Gains `brand_refs[]` — pointer brands whose canonical documents live elsewhere (child-owned data). Each entry: `{ domain, brand_id?, managed_by? }`. `managed_by` (optional) is house-declared, non-trust-bearing — for grouping and discovery, used by holdcos to express agency-network delegation. Required widened from `["house", "brands"]` to `["house"]` with `anyOf` requiring at least one of `brands[]` or `brand_refs[]`.

**Typed brand-level trademarks.** New `#/definitions/trademark` extracts the inline house-portfolio shape (`{registry, number, mark}`) as a named definition with optional `status`, `license_type`, `countries`. The existing `brand` definition now accepts typed `trademarks: Trademark[]`, enabling both inline `brands[]` entries and self-publishing Brand Canonical Documents to carry their brand-specific marks. House-level `trademarks[]` remains for corporate-level marks; resolution is union.

**Trust model.** A child Brand Canonical Document declares `house_domain: "<house>"`; the house's `brand_refs[]` must reciprocate for mutual-assertion trust. Inline children (`brands[]`) are covered by the parent's document authenticity directly. `managed_by` carries no trust weight. Standalone (no `house_domain`) trumps any third-party portfolio claim. Compliance fields resolve strictest-of house and brand.

**Cross-array invariant** (validator + lint, not JSON Schema expressible): a `brand_id` MUST NOT appear in both `brands[]` and `brand_refs[]` of the same house.

`brand-json.mdx` is the normative spec — Motivation, the five variants, the trust model, the resolution algorithm, Conformance, and prior art (ads.txt / sellers.json) all live there.
