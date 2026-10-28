---
"adcontextprotocol": patch
---

Bound the arrays and strings that are new in 3.3 or experimental. 638 `maxItems` and `maxLength` keywords go onto 153 schemas, chosen from the tiers in `specs/collection-bounds-proposal.md`: 32 for enum sets and closed vocabularies, 100 for typical lists, 255 for identifiers and names, 2,000 for prose, 2,048 for URLs. No stable field changes and no property is added, removed or made required, so the additive-minor check has nothing to compare: each field is either absent from 3.2.7 or experimental. `get_adcp_capabilities` is untouched (#8198).

Adds `scripts/audit-schema-bounds.cjs`, an inventory of every remaining unbounded array and string by stability and by request or response side, with a proposed limit for each. The stable fields are proposed for 4.0 and registered as the `schema_bounds_required_in_4_0` check in the v4 compatibility registry. Property and collection lists carried inline are flagged to move out of band in 4.0.
