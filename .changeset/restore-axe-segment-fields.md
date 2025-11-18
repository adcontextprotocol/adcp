---
"adcontextprotocol": patch
---

Restore axe_include_segment and axe_exclude_segment targeting fields

These fields were accidentally removed from the targeting schema and have been restored to enable AXE segment targeting functionality.

**Restored fields:**
- `axe_include_segment` - AXE segment ID to include for targeting
- `axe_exclude_segment` - AXE segment ID to exclude from targeting

**Updated documentation:**
- Added AXE segment fields to create_media_buy task reference
- Added detailed parameter descriptions in targeting advanced topics
