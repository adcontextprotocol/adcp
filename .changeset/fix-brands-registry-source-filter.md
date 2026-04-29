---
---

Fix `?source=` filter on `GET /api/brands/registry` — the parameter was silently ignored; all three values (`brand_json`, `enriched`, `community`) now correctly filter the response. Stats remain global (unfiltered) regardless of the source param, matching `/api/properties/registry` behavior. Previously-sent source filters will now produce filtered results instead of the full set.
