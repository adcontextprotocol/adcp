---
"adcontextprotocol": minor
---

Schema refinements for frequency caps, signal pricing, audience identifiers, keyword capabilities, and duration representation.

- **Duration type**: Added reusable `core/duration.json` schema (`{interval, unit}` where unit is `"minutes"`, `"hours"`, `"days"`, or `"campaign"`). Used consistently for all time durations. When unit is `"campaign"`, interval must be 1 — the window spans the full campaign flight. (#1215)
- **FrequencyCap.window**: Changed from pattern-validated string (`"7d"`) to a duration object (e.g. `{"interval": 7, "unit": "days"}` or `{"interval": 1, "unit": "campaign"}`). Also applied to `optimization_goal.target_frequency.window`. (#1215)
- **Attribution windows**: Replaced string fields with duration objects throughout. `attribution_window.click_through`/`view_through` (strings) became `post_click`/`post_view` (duration objects) on optimization goals, capability declarations, and delivery response. (#1215)
- **FlatFeePricing.period**: Added required `period` field (`monthly | quarterly | annual | campaign`) so buyers know the billing cadence for flat-fee signals. (#1216)
- **FrequencyCap.suppress**: Replaced `suppress_minutes` (scalar) with `suppress` (duration object, e.g. `{"interval": 60, "unit": "minutes"}`). All frequency cap time fields now use the same `{interval, unit}` pattern. (#1215)
- **supported_identifier_types**: Removed `platform_customer_id` from the identifier type enum. Added `supports_platform_customer_id` boolean to audience targeting capabilities — a binary capability flag is clearer than an enum value for this closed-ecosystem matching key. (#1217)
- **Keyword targeting capabilities**: Changed `execution.targeting.keyword_targets` and `execution.targeting.negative_keywords` from boolean to objects with `supported_match_types: ("broad" | "phrase" | "exact")[]`, so buyers know which match types each seller accepts before sending. (#1218)
