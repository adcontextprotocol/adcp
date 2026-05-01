---
"adcontextprotocol": minor
---

Schema implementation cut for the distributed brand.json RFC ([#3533](https://github.com/adcontextprotocol/adcp/pull/3533)). Additive — existing publishers unchanged.

**`brand.json` schema additions:**

- New top-level variant: **Brand Canonical Document** — a self-published per-brand document carrying the brand's identity attributes plus `parent_house: BrandRef` (pointer to the corporate house) and optional `house_attributes_overrides`.
- **House Portfolio** variant gains:
  - `brand_refs: BrandRef[]` — pointer brands whose canonical documents live elsewhere (child-owned data). Mutual-assertion trust required.
  - `house_attributes` — house-wide attributes inherited by all brands (privacy policy, compliance flags, corporate legal entity).
- House Portfolio `required` widened from `["house", "brands"]` to `["house"]` with `anyOf` requiring at least one of `brands[]` or `brand_refs[]`.

**Cross-array invariant** (validator + lint, not JSON Schema expressible): a `brand_id` MUST NOT appear in both `brands[]` and `brand_refs[]` of the same house.

**Trust model summary** (full text in the RFC): a child brand canonical document declares `parent_house: { domain: <house> }`; the house's `brand_refs[]` must reciprocate for mutual-assertion trust. Inline children (`brands[]`) are covered by the parent's document authenticity directly.

**Status:** for review of the concrete shape only. Not normative until the RFC ratifies. The `brand-json.mdx` reference page carries a "Proposed" callout pointing at #3533.
