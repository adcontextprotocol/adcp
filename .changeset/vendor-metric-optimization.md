---
"adcontextprotocol": minor
---

Add `kind: "vendor_metric"` optimization goal — end-to-end buyer→seller→vendor binding for vendor-attested measurement (attention, brand lift, emissions, retail-media partner metrics). Closes #4644.

**The problem.** The `metric` kind's enum had `attention_seconds` and `attention_score` as if they were seller-native metrics — but DoubleVerify, IAS, Adelaide, TVision, and Lumen each define attention differently with no MRC-or-equivalent shared standard. A buyer setting `{ metric: "attention_seconds" }` was asking a meaningless question — *whose* attention model? The seller had to guess, and delivery reconciliation against `vendor_metric_values[]` (which IS vendor-keyed) couldn't close the loop.

**The fix — three additions that mirror existing patterns:**

1. **`kind: "vendor_metric"` on `optimization-goal.json`** — third oneOf branch, structurally parallel to the existing `event` kind (which binds buyer-attested conversion events). Shape:

   ```json
   {
     "kind": "vendor_metric",
     "vendor": { "domain": "adelaidemetrics.com" },
     "metric_id": "attention_score",
     "target": { "kind": "threshold_rate", "value": 70 },
     "priority": 1
   }
   ```

   `vendor` is the same BrandRef shape used on `vendor_metric_values.vendor`, `reporting_capabilities.vendor_metrics[].vendor`, and `performance_standards.vendor` — symmetric across discovery, capability, commitment, optimization, and reporting surfaces. `metric_id` is the same `vendor-metric-id` reference used on the reporting side. Targets are `cost_per` and `threshold_rate` (no `maximize_value` — that's monetary-only).

2. **New `core/vendor-metric-optimization.json` capability schema** — product-level declaration of which `(vendor, metric_id)` pairs the product's bidding stack can steer toward, with `supported_targets` per pair. Referenced from `product.json` alongside `metric_optimization` and `reporting_capabilities`. Per-product, not per-seller, because measurement integrations vary by inventory (premium CTV may have DV attention integrated; remnant display won't).

3. **Three-precondition rejection rule.** Sellers MUST reject `vendor_metric` goals failing any of:

   - **Discovery** — `metric_id` is in the vendor's published `measurement.metrics[]` catalog.
   - **Capability** — `(vendor, metric_id)` is in the product's `vendor_metric_optimization.supported_metrics[]`, and `target.kind` is in the matching entry's `supported_targets`.
   - **Reporting coherence** — the package's `committed_metrics[]` includes a matching `{ scope: "vendor", vendor, metric_id }`. **Optimization without committed reporting is unverifiable** — the buyer can't grade the seller against a goal whose value isn't contractually reported. This precondition is what makes vendor-attested optimization meaningful at the wire level.

**The deprecation.** `attention_seconds` and `attention_score` remain in the `metric` enum on `optimization-goal.json` and on `product.json` `metric_optimization.supported_metrics` for backwards compatibility this minor, marked **deprecated** in their descriptions. Slated for removal at the next major. Sellers MAY reject the deprecated values with `TERMS_REJECTED` and a pointer to the `vendor_metric` kind. Same deprecation pattern used elsewhere (e.g., `delivery_measurement.provider` → `vendors[]`).

**What this unblocks.** The same `vendor_metric` shape generalizes to:
- Panel-based brand lift (Kantar, Upwave, Cint)
- Emissions optimization (Scope3, Good-Loop)
- Retail-media partner metrics (Amazon, Walmart Connect, Criteo)
- Any future vendor-attested measurement that adopters want as an optimization target

**Symmetry summary** — same `(vendor, metric_id)` key across every surface:

| Surface | Field | What it asserts |
|---|---|---|
| Discovery | Vendor's `get_adcp_capabilities.measurement.metrics[]` | "This metric exists in my catalog" |
| Capability — reporting | Product's `reporting_capabilities.vendor_metrics` | "This product can report this vendor metric" |
| Capability — optimization | Product's `vendor_metric_optimization.supported_metrics` (new) | "This product's bidder can steer toward this vendor metric" |
| Commitment | Package's `committed_metrics` (scope: vendor) | "I commit to reporting this for this package" |
| Optimization | Package's `optimization_goals` (kind: vendor_metric) (new) | "Steer delivery toward this for this package" |
| Accountability | Package's `performance_standards.vendor` | "I commit to a threshold on this metric" |
| Delivery — value | `vendor_metric_values` | "Here's what was measured" |
| Delivery — missing | `missing_metrics` (scope: vendor) | "I committed but couldn't deliver" |

**Backwards compatibility.** Additive — new schema, new oneOf branch, new optional product field, deprecated-but-still-valid enum values. Existing 3.x agents continue to validate. Buyers adopting `vendor_metric` need the matching seller-side capability + commitment in place; the three-precondition rule prevents silent acceptance of orphaned goals.

**Doc updates.** New `kind: vendor_metric` section in `docs/media-buy/conversion-tracking/index.mdx` (alongside `kind: event` and `kind: metric`); Target Kinds and Choosing a Strategy tables updated; migration doc reflects deprecation routing.

Opened as draft for a 7-day WG comment window before merge — measurement vendors (DV/IAS/Adelaide/Kantar/Scope3) invited to raise extension needs (e.g., `qualifier` slots for vendor sub-models) while the shape is still flexible.

Closes #4644.
