---
"adcontextprotocol": minor
---

Schema refinements for frequency caps, signal pricing, audience identifiers, keyword capabilities, and duration representation.

- **Duration type**: Added reusable `core/duration.json` schema (`{value, unit}` where unit is `"hours"` or `"days"`). Replaces compact duration strings throughout the spec. (#1215)
- **FrequencyCap.window**: Changed from pattern-validated string (`"7d"`) to a `oneOf`: a `duration` object (e.g. `{"value": 7, "unit": "days"}`) or the string `"campaign"`. Also applied to `optimization_goal.target_frequency.window`. (#1215)
- **Attribution windows**: Replaced string duration fields with integer days throughout. `attribution_window.click_through`/`view_through` (strings) became `click_through_days`/`view_through_days` (integers) on optimization goals, capability declarations, and delivery response (`attribution-window.json` renamed from `click_window_days`/`view_window_days` for consistency). (#1215)
- **FlatFeePricing.period**: Added required `period` field (`monthly | quarterly | annual | campaign`) so buyers know the billing cadence for flat-fee signals. (#1216)
- **supported_identifier_types**: Renamed `external_id` to `platform_customer_id` to disambiguate from `AudienceMember.external_id` (buyer-side deduplication key). `platform_customer_id` signals that the seller accepts the buyer's CRM/loyalty ID for matching in a closed ecosystem. (#1217)
- **Keyword targeting capabilities**: Changed `execution.targeting.keyword_targets` and `execution.targeting.negative_keywords` from boolean to objects with `supported_match_types: ("broad" | "phrase" | "exact")[]`, so buyers know which match types each seller accepts before sending. (#1218)
