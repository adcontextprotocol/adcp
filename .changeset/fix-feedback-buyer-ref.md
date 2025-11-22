---
"adcontextprotocol": patch
---

Fix provide_performance_feedback to support buyer_ref identifier

The provide_performance_feedback request schema now accepts either `media_buy_id` or `buyer_ref` to identify the media buy, matching the pattern used in update_media_buy and other operations. This was the only schema in the entire specification that forced buyers to track publisher-assigned IDs, creating an inconsistency.

**What changed:**
- Added `buyer_ref` field to provide-performance-feedback-request.json
- Changed `required` array to `oneOf` pattern allowing either identifier
- Buyers can now provide feedback using their own reference instead of having to track the publisher's media_buy_id

**Impact:**
- Backward compatible - existing calls using media_buy_id continue to work
- Removes the only forced ID tracking requirement in the buyer workflow
- Aligns with the principle that buyers use their own references throughout
