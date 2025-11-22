---
"adcontextprotocol": minor
---

Add media_buy_ids and buyer_refs filters to list_creatives for campaign-level creative discovery.

**New Filter Capabilities:**

1. **Media Buy Filtering** - Use `media_buy_ids` to find all creatives assigned to specific media buys
2. **Buyer Reference Search** - Use `buyer_refs` to find creatives across campaigns with matching buyer references

**Schema Changes:**
- Added `media_buy_ids` array filter to list-creatives-request
- Added `buyer_refs` array filter to list-creatives-request
- Both filters use array format for consistency with existing patterns like `assigned_to_packages`

**Use Cases:**
- Find all creatives used in a specific campaign (by media_buy_id)
- Search creatives across related campaigns (by buyer_ref)
- Audit creative usage at the campaign level
- Performance analysis across buyer-defined campaign groupings

This complements existing package-level filtering (`assigned_to_packages`) by enabling campaign-level creative discovery.
