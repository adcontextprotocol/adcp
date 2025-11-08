---
"adcontextprotocol": minor
---

- Enhanced `get_media_buy_delivery` response to include package-level pricing information: `pricing_model`, `rate`, and `currency` fields added to `by_package` section.
- Added offline file delivery examples for JSON Lines (JSONL), CSV, and Parquet formats.
- Added tab structure to list different formats of offline delivery files in optimization reporting documentation.
- Updated all delivery reporting examples to include new pricing fields.
- Added comprehensive JSONL, CSV, and Parquet format examples with schema documentation.

**Impact:**
- Buyers can now see pricing information directly in delivery reports for better cost analysis.
- Publishers have clearer guidance on structured batch reporting formats that maintain nested data.
- Documentation provides a detailed examples for implementing offline file delivery.

