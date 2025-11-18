---
"adcontextprotocol": patch
---

Restore Offline File Delivery (Batch) section and update pre-push validation to use Mintlify.

Restored the "Offline File Delivery (Batch)" section that was removed in PR #203 due to MDX parsing errors. The section now uses Mintlify-compatible tab syntax (`<Tab>`) instead of Docusaurus `TabItem` syntax.

**Changes:**
- Restored comprehensive format examples for JSONL, CSV, and Parquet formats
- Fixed empty space issue at `#offline-file-delivery-batch` anchor
- Updated pre-push hook to validate with Mintlify (broken links and accessibility checks) instead of Docusaurus build
- Aligned validation with production system (Mintlify)

This ensures the documentation section works correctly in production and prevents future removals due to syntax conflicts between Docusaurus and Mintlify.

