---
"adcontextprotocol": patch
---

Fix three inline enum drift bugs where canonical enum files gained values that were missed in inline copies, and add a CI lint to prevent the class of bug.

- Replace inline property-type enum in get-adcp-capabilities-response.json trusted_match.surfaces with $ref (missing linear_tv)
- Replace inline adcp-protocol enum in registry-event.json badgeRole with $ref (missing measurement)
- Replace inline catalog-type enum in sponsored_placement.json supported_catalog_types with $ref (missing promotion)
- Add scripts/lint-schema-enum-drift.cjs: detects inline enums that are strict subsets of canonical enums, preventing future drift
