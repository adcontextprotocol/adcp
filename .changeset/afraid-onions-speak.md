---
"adcontextprotocol": minor
---

Add broadcast TV support: Ad-ID creative identifiers, broadcast spot reference formats, agency estimate numbers, and measurement maturation windows.

- Add `industry_identifiers` to creative-asset and creative-manifest schemas with `creative-identifier-type` enum (ad_id, isci, clearcast_clock)
- Add broadcast spot reference formats (15s, 30s, 60s) — video file only, no VAST/trackers/clickthrough
- Add `agency_estimate_number` to create-media-buy-request, package-request, and confirmed package schemas
- Add `measurement-window` schema and `measurement_windows` array on reporting-capabilities for broadcast Live/C3/C7 windows
- Add `measurement_window` field on billing_measurement in measurement-terms for guarantee basis
- Add broadcast TV channel documentation
