---
"adcontextprotocol": minor
---

`brand.json` gains a fifth variant and distributed publishing model. Additive — existing publishers unchanged.

**New variant — Brand Canonical Document.** A self-published per-brand document carrying the brand's identity attributes plus optional `house_domain` (string, the domain of the brand's parent house). Standalone brands (no parent house — Patagonia, Liquid Death) omit `house_domain`. Excludes top-level house-only fields (`house`, `brands`, `brand_refs`, `authorized_operators`) and redirect-variant fields (`authoritative_location`, `region`, `note`, `redirect_reason`, `redirect_effective_at`) to disambiguate from the other four variants.

**House Portfolio additions.** Gains `brand_refs[]` — portfolio entries for brands whose canonical documents live elsewhere (child-owned data). Each entry has shape `{ domain, brand_id, managed_by?, effective_at? }`. The entry shape is defined as `#/definitions/portfolio_entry` (the name is distinct from `core/brand-ref.json`, which is the buyer-side schema for identifying brands in media-buy plans). `managed_by` (optional) is house-declared and explicitly non-trust-bearing — it's a directory field for aggregation across houses. `effective_at` (optional) is the publisher-declared timestamp consumers use to age mutual-assertion edges. Required widened from `["house", "brands"]` to `["house"]` with `anyOf` requiring at least one of `brands[]` or `brand_refs[]`.

**Trust model.** A child Brand Canonical Document declares `house_domain: "<house>"`; the house's `brand_refs[]` must reciprocate for mutual-assertion trust. Trust resolves at two layers: brand identity (logos/colors/tone/tagline — authoritative on the leaf's TLS alone) and brand relationships (governance, billable inclusion — gated on mutual assertion). A leaf-only edge keeps identity trust and surfaces a self-healing notification SHOULD to the house's `contact.email`. Standalone (no `house_domain`) trumps any third-party portfolio claim. Compliance fields resolve strictest-of (union); `policy_categories` and brand-level `disclaimers[]` enumerated alongside `data_subject_contestation` and `compliance_policies`.

**Typed brand-level trademarks.** New `#/definitions/trademark` extracts the inline house-portfolio shape (`{registry, number, mark}`) as a named definition with optional `status`, `license_type`, `licensor_domain` (when `license_type=licensed_in`), `countries`, and `nice_classes` (Nice Classification for cross-industry disambiguation — Delta-airline vs Delta-faucet). The existing `brand` definition now accepts typed `trademarks: Trademark[]`, enabling both inline `brands[]` entries and self-publishing Brand Canonical Documents to carry their brand-specific marks. House-level `trademarks[]` remains for corporate-level marks; resolution is union.

**Conformance invariants** (validator + lint, not JSON Schema expressible):

- `brand_id` MUST NOT appear in both `brands[]` and `brand_refs[]`; `brand_id` and `domain` MUST each be unique within `brand_refs[]`.
- `house_domain` MUST NOT appear inside `brands[]` entries.
- Mutual-assertion verification MUST follow House Redirects on the house side before comparing membership.
- `managed_by` is a directory field — consumers MUST NOT use it for trust or authorization. Aggregation by `managed_by` is the intended use.
- Standalone trumps third-party claim.
- Compliance strictest-of for `data_subject_contestation`, `compliance_policies`, `policy_categories`, audience exclusions, regulated-category flags, and brand-level `disclaimers[]`.
- Edge aging via `brand_refs[].effective_at` (or consumer's first observation); AAO's reference crawler ages at 180 days.
- Self-healing: leaf-only edges SHOULD trigger consumer-side notification to the house's `contact.email`, rate-limited per `{leaf, house}` pair.

**Publisher migration.** Free-text values for the existing inline `trademarks[].status` or `trademarks[].countries` properties now must conform to the typed enum (`active|pending|abandoned|cancelled|expired`) and ISO 3166-1 alpha-2 respectively. Publishers using non-conforming values will surface validation errors and need to update; the field shape was previously open via `additionalProperties: true` so this is the only behaviour change visible to existing data.

`brand-json.mdx` is the normative spec — Motivation, the five variants, the trust model with self-healing notification, Adopting `brand_refs[]`, Out-of-scope cases (JVs, PE-opacity, jurisdictional governance), the resolution algorithm, Trademarks, Conformance, and prior art (ads.txt / app-ads.txt / sellers.json, WebFinger / host-meta) all live there.
