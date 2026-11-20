---
"adcontextprotocol": patch
---

Every branch of a discriminated union states its tag's value as its `default`. Where a union's branches pin one property to a `const` (or a one-value `enum`), each branch now carries `"default"` equal to that value, beside the `const`. 529 tag properties in 147 unions gain the annotation. A table of `anyOf` value constraints, such as the country and postal-system pairs in `core/postal-country-system.json`, is a guard rather than a tagged union and gets no default. `default` is an annotation, so no payload's validity changes.

209 objects that stand for a concept of their own gain a `title` naming it, so generated types and docs name the concept instead of a path.

Geographic objects have one definition each under `core/`: `geo-coordinates`, `postal-address`, `geo-country-place-types`, `geo-region-countries` (with `geo-region-all-values-selector` and `country-subdivision-value-set`), `geo-proximity`, `metro-area`, `geojson-geometry`, `radius`, and `travel-time`. The `targeting_modification` postal-area selector references `core/postal-country-system.json` and takes its country/system pairing guard.

Ranges, durations, and money-like objects have one definition each under `core/`: `numeric-range`, `numeric-value-range`, `fixed-duration`, `closed-money`, `half-open-datetime-range`, `evidence-max-age`, `target-frequency`, `total-budget-guidance`, and `flight-endpoint`. The proposal `total_budget_guidance` requires `currency` and at least one of `min`, `recommended`, and `max`, as the canonical proposal does, and the `get_media_buy_artifacts` `time_range` requires `start` and `end`.

DOOH placement objects and pixel sizes have one definition each under `core/`: `pixel-size`, `dooh-address`, `dooh-location`, `dooh-screen-resolution`, and `render-dimensions`. Every pixel size rejects `unit`, and the `image_carousel` card size is open like the others.

Property identifiers and tag metadata have one definition each: `core/tag-metadata.json`, `core/tag-metadata-map.json`, `core/platform-independent-distribution-identifier.json`, and `core/distribution-identifier.json`. Property, placement, and test-controller identifiers reference `core/identifier.json` and take its domain and subdomain value rules.
