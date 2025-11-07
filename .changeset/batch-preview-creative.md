---
"adcontextprotocol": minor
---

Add batch preview support to `preview_creative` task for 5-10x faster preview generation of multiple creative manifests.

**Enhancement:**
- `preview_creative` now accepts either a single creative request OR a `requests` array for batch processing
- Batch mode supports 1-50 creatives in one API call
- Response format matches request mode (single response or `results` array)

**Benefits:**
- 5-10x faster than individual API calls for 10+ creatives
- Single HTTP round trip reduces latency and server load
- Supports partial success - some previews can succeed while others fail
- No breaking changes - existing single-creative requests work identically

**Backward Compatibility:**
- Existing single-creative requests unchanged (same request/response structure)
- Schema uses `oneOf` to accept either format
- Both modes coexist seamlessly

**Use Cases:**
- Bulk creative review for campaigns
- Multi-format preview generation
- A/B testing creative variations
- High-concurrency preview workflows

**Schema Changes:**
- `/schemas/v1/creative/preview-creative-request.json` - Now accepts single OR batch requests via `oneOf`
- `/schemas/v1/creative/preview-creative-response.json` - Returns single OR batch responses via `oneOf`
