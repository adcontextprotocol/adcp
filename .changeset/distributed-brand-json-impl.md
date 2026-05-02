---
"adcontextprotocol": minor
---

Schema implementation cut for the distributed brand.json RFC ([#3533](https://github.com/adcontextprotocol/adcp/pull/3533)). Additive — existing publishers unchanged.

**`brand.json` schema additions:**

- New top-level variant: **Brand Canonical Document** — a self-published per-brand document carrying the brand's identity attributes plus optional `house_domain` (string, the domain of the brand's parent house). Standalone brands (no parent house — Patagonia, Liquid Death) omit `house_domain`. Excludes top-level house-only fields (`house`, `brands`, `brand_refs`, `authorized_operators`) to disambiguate from House Portfolio.
- **House Portfolio** variant gains `brand_refs[]` — pointer brands whose canonical documents live elsewhere (child-owned data). Each entry: `{ domain, brand_id?, managed_by? }`. `managed_by` (optional) is house-declared, non-trust-bearing — for grouping and discovery, used by holdcos to express agency-network delegation.
- House Portfolio `required` widened from `["house", "brands"]` to `["house"]` with `anyOf` requiring at least one of `brands[]` or `brand_refs[]`.
- All new fields reuse existing schema patterns (`#/definitions/domain`, `#/definitions/brand_id`); no new `core/*.json` files added.

**Cross-array invariant** (validator + lint, not JSON Schema expressible): a `brand_id` MUST NOT appear in both `brands[]` and `brand_refs[]` of the same house.

**Trust model summary** (full text in the RFC): a child brand canonical document declares `house_domain: "<house>"`; the house's `brand_refs[]` must reciprocate for mutual-assertion trust. Inline children (`brands[]`) are covered by the parent's document authenticity directly. `managed_by` carries no trust weight.

**Status:** for review of the concrete shape only. Not normative until the RFC ratifies. The `brand-json.mdx` reference page carries a "Proposed" callout pointing at #3533 and worked examples (Nike mixed hybrid, WPP with delegation, Converse self-published, Patagonia standalone).
