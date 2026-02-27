---
"adcontextprotocol": minor
---

Schema refinements for frequency caps, signal pricing, audience identifiers, and keyword capabilities.

- **FrequencyCap.window**: Constrained from bare `string` to a pattern-validated format: `{integer}{h|d}` or `campaign` (e.g. `1h`, `7d`, `30d`, `campaign`). Also applied to `optimization_goal.target_frequency.window`. (#1215)
- **FlatFeePricing.period**: Added required `period` field (`monthly | quarterly | annual | campaign`) so buyers know the billing cadence for flat-fee signals. (#1216)
- **supported_identifier_types**: Renamed `external_id` to `platform_customer_id` to disambiguate from `AudienceMember.external_id` (buyer-side deduplication key). `platform_customer_id` signals that the seller accepts the buyer's CRM/loyalty ID for matching in a closed ecosystem. (#1217)
- **Keyword targeting capabilities**: Changed `execution.targeting.keyword_targets` and `execution.targeting.negative_keywords` from boolean to objects with `supported_match_types: ("broad" | "phrase" | "exact")[]`, so buyers know which match types each seller accepts before sending. (#1218)
