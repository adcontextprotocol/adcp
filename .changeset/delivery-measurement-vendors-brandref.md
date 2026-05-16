---
"adcontextprotocol": minor
---

Restructure `product.delivery_measurement.provider` as a `vendors: BrandRef[]` array, deprecating the legacy free-form string. Closes the BrandRef-migration half of #3860; the merger-with-`performance_standards` question is deferred to a follow-up RFC since it requires more design (`delivery_measurement` describes the *overall* measurement story while `performance_standards` carries *committed* metrics with thresholds — they're different concerns).

**The BrandRef migration.** Before this minor, `delivery_measurement.provider` was a string like `"Google Ad Manager with IAS viewability"` — buyer agents had to string-parse to find the verification vendor. The string also conflated two jobs: vendor identity AND methodology description. With this minor:

- New `vendors: BrandRef[]` field — structured measurement-vendor identity, anchored on `brand.json` `agents[type='measurement']`. Array because a single product often has multiple vendors playing different roles (ad server + viewability vendor; retail-media seller + third-party retail measurement). Each entry's measurement-agent capabilities catalog is queryable via `get_adcp_capabilities.measurement.metrics[]`.
- Legacy `provider: string` — marked deprecated. Dropped from the schema's `required` array (was previously the lone required field on `delivery_measurement`); retained for one-minor backwards compatibility. When both fields present, consumers MUST use `vendors` for identity and treat `provider` as informational text.
- `notes: string` — clarified as free-form methodology prose only, not vendor identification.

**Distinct from `performance_standards.vendor`.** `delivery_measurement.vendors` carries vendor identity for the overall measurement story (including non-committed-but-reported metrics); `performance_standards[].vendor` carries vendor identity for *committed* metrics with thresholds. The two fields cover different scopes — the merger question raised in #3860 is deferred.

**Migration.**

```json
// before
"delivery_measurement": {
  "provider": "Google Ad Manager with IAS viewability",
  "notes": "MRC-accredited viewability. 50% in-view for 1s display / 2s video."
}

// after
"delivery_measurement": {
  "vendors": [
    { "domain": "googleadmanager.com" },
    { "domain": "integralads.com" }
  ],
  "notes": "MRC-accredited viewability. 50% in-view for 1s display / 2s video."
}
```

**Backwards compatibility.** Additive (new field, deprecated field retained, required dropped). Existing implementations populating `provider` continue to work for one minor; removed at the next major.

**Doc updates.** `media-products.mdx` field description reflects the structured shape.

Closes #3860 (BrandRef migration). The merger-with-`performance_standards` question stays open as a follow-up.
