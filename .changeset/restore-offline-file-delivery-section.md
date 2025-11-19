---
"adcontextprotocol": patch
---

Restore Offline File Delivery (Batch) section and update pre-push validation to use Mintlify.

Restored the "Offline File Delivery (Batch)" section that was removed in PR #203 due to MDX parsing errors. The section now uses regular markdown sections instead of tabs to avoid MDX parsing issues.

**Changes:**
- Restored comprehensive format examples for JSONL, CSV, and Parquet formats
- Fixed empty space issue at `#offline-file-delivery-batch` anchor
- Reordered the Delivery Methods section to make the structure more reasonable - Delivery Methods is now the parent section with Webhook-Based Reporting and Offline-File-Delivery-Based Reporting as subsections
- Updated pre-push hook to validate with Mintlify (broken links and accessibility checks) instead of Docusaurus build
- Aligned validation with production system (Mintlify)
- Added missing fields (notification_type, sequence_number, next_expected_at) to all offline file format examples
- Updated CSV format to use dot notation (by_package.pricing_model, totals.impressions)

This ensures the documentation section works correctly in production and prevents future removals due to syntax conflicts between Docusaurus and Mintlify.

