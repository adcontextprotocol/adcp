---
"adcontextprotocol": minor
---

Discriminate flat_rate pricing parameters by inventory type and clarify package type names.

**Breaking for existing v3 DOOH flat_rate parameters:** `flat-rate-option.json` `parameters` now requires a `"type": "dooh"` discriminator field. Existing implementations passing `parameters` without `type` must add `"type": "dooh"`. Sponsorship/takeover flat_rate options that have no `parameters` are unaffected.

DOOH `parameters` fields: `sov_percentage`, `loop_duration_seconds`, `min_plays_per_hour`, `venue_package`, `duration_hours`, `daypart`, `estimated_impressions`. `min_plays_per_hour` minimum is now 1 (was 0).

`get-media-buys-response.json` inline package items are now titled `PackageStatus` to distinguish them from `PackageRequest` (create input) and `Package` (create output). The name reflects what this type adds: creative approval state and an optional delivery snapshot.
