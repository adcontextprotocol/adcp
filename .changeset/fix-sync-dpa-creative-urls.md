---
---

Fix macro-encoding drift in `sales-social/catalog_driven_dynamic_ads/sync_dpa_creative` (adcp#2763 cluster follow-up to #2768 / #2781 / #2788 / #2798).

The fixture's tracker URLs wrote catalog-item macros in raw `{SKU}` / `{GTIN}` / `{MEDIA_BUY_ID}` form. The step's own narrative documents that "values substituted into URL contexts MUST be percent-encoded such that only RFC 3986 unreserved characters remain unescaped" (citing #2620) — so the canonical form is `%7BSKU%7D` etc. The raw braces broke `format: uri` on every branch of creative-manifest.assets' anyOf, producing 60 spurious lint errors. Encoding matches both the protocol intent and what a conformant platform would actually receive over the wire.

Allowlist shrinks 13 → 12. Nothing else actionable remains — the remaining 12 entries are all blocked on upstream WG issues adcp#2774-#2776.
