---
---

Fix `?source=` filter on `GET /api/brands/registry` — the parameter was silently ignored. The four accepted values (`hosted`, `brand_json`, `community`, `enriched`) now match the per-row `source` field in the response one-to-one, so filter and response round-trip. `?source=hosted` returns owner-registered brands (the response label `is_public=true` rows carry); `?source=brand_json` returns crawler-discovered brands with a live `/.well-known/brand.json` and excludes owner-registered rows. Stats gain a `hosted` field and split it from `brand_json` so the buckets are disjoint and reconcile with the filter results — matches the existing admin UI which already displayed `stats.hosted` separately. Stats remain global regardless of the source param, matching `/api/properties/registry` behavior.

**Visible behavior change on `/brands.html`**: the "brand.json" stat card now reflects the strict definition — only crawler-discovered brands with a live `/.well-known/brand.json`. Owner-registered brands move to (existing) hosted accounting; the public page does not yet surface a hosted card. Counts on this card will drop until a follow-up adds the hosted display.
