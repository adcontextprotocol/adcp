---
"adcontextprotocol": minor
---

Make create_media_buy and update_media_buy responses consistent by returning full Package objects.

**Changes:**

- `create_media_buy` response now returns full Package objects instead of just package_id + buyer_ref
- `update_media_buy` response already returned full Package objects (no change to behavior)
- Both responses now have identical Package structure for consistency

**Benefits:**

- **Consistency**: Both create and update operations return the same response structure
- **Full state visibility**: Buyers see complete package state including budget, status, targeting, creative assignments
- **Single parse pattern**: Client code can use the same parsing logic for both operations
- **Atomic state view**: Buyers see exactly what was created/modified without follow-up calls
- **Modification transparency**: If publisher adjusted budget or other fields, buyer sees actual values immediately

**Backward Compatibility:**

- **Additive change only**: New fields added to create_media_buy response
- **Existing fields unchanged**: media_buy_id, buyer_ref, creative_deadline, packages array all remain
- **Non-breaking**: Clients parsing just package_id and buyer_ref will continue to work
- **Dual ID support maintained**: Both publisher IDs (media_buy_id, package_id) and buyer refs are included

**Response Structure:**

```json
{
  "media_buy_id": "mb_12345",
  "buyer_ref": "campaign_ref",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {
      "package_id": "pkg_001",
      "buyer_ref": "package_ref",
      "product_id": "ctv_premium",
      "budget": 50000,
      "status": "active",
      "pacing": "even",
      "pricing_option_id": "cpm-fixed",
      "creative_assignments": [],
      "format_ids_to_provide": [...]
    }
  ]
}
```
