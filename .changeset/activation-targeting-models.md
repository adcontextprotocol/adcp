---
"adcontextprotocol": minor
---

Add support for multiple activation models in activate_signal response.

Different decisioning platforms use fundamentally different targeting mechanisms. This update adds explicit support for:

**Segment-Based Activation** (DSPs/SSPs like The Trade Desk, DV360, Scope3):
- Returns `decisioning_platform_segment_id` for campaign targeting

**Key-Value Targeting** (GAM and ad servers):
- Returns `targeting_key_values` object with key-value pairs
- Used by platforms that don't have segment IDs (e.g., GAM line item targeting)

**Deal-Based Activation** (PMP/PG):
- Returns `deal_id` for programmatic guaranteed/marketplace deals
- Optional `activation_metadata` for additional platform requirements

**Breaking Change**: The response now requires exactly ONE of these fields (enforced via `oneOf` constraint). Previous implementations that relied solely on `decisioning_platform_segment_id` remain compatible for segment-based platforms.

**New schemas:**
- Updated `activate-signal-response.json` with union type support
- Added `targeting_key_values`, `deal_id`, and `activation_metadata` fields
- Schema enforces mutual exclusivity via `oneOf` constraint
