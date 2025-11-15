---
"adcontextprotocol": patch
---

Fix get_products documentation to match Product schema structure.

**What changed:**
- Corrected `properties` field to `publisher_properties` in all examples
- Fixed structure: properties are now grouped by `publisher_domain`
- Each publisher entry uses either `property_ids` OR `property_tags` (mutually exclusive)
- Updated all validation examples to reflect correct schema structure
- Added `delivery_measurement` and `pricing_options` to examples (required fields)

**Why:**
The documentation showed a flat `properties` array that didn't match the actual Product JSON schema. The schema correctly uses `publisher_properties` which groups property references by publisher domain, enabling proper authorization validation workflow.
