---
"adcontextprotocol": minor
---

Add batch preview and direct HTML embedding support to `preview_creative` task for dramatically faster preview workflows.

**Enhancements:**

1. **Batch Mode** - Preview 1-50 creatives in one API call (5-10x faster)
   - Request includes `requests` array instead of single creative
   - Response returns `results` array with success/error per creative
   - Supports partial success (some succeed, others fail)
   - Order preservation (results match request order)

2. **Direct HTML Embedding** - Skip iframes entirely with `output_format: "html"`
   - Request includes `output_format: "html"` parameter
   - Response includes `preview_html` field with raw HTML
   - No iframe overhead - embed HTML directly in page
   - Perfect for grids of 50+ previews
   - Batch-level and per-request `output_format` support

**Benefits:**
- **Performance**: 5-10x faster for 10+ creatives (single HTTP round trip)
- **Scalability**: No 50 iframe requests for preview grids
- **Flexibility**: Mix formats and output types in one batch
- **Developer Experience**: Simpler grid rendering with direct HTML

**Backward Compatibility:**
- Existing requests unchanged (same request/response structure)
- Default `output_format: "url"` maintains iframe behavior
- Schema uses `oneOf` for seamless mode detection
- No breaking changes

**Use Cases:**
- Bulk creative review UIs with 50+ preview grids
- Campaign management dashboards
- A/B testing creative variations
- Multi-format preview generation

**Schema Changes:**
- `/schemas/v1/creative/preview-creative-request.json`:
  - Accepts single OR batch requests via `oneOf`
  - New `output_format` parameter ("url" | "html")
- `/schemas/v1/creative/preview-creative-response.json`:
  - Returns single OR batch responses via `oneOf`
  - New `preview_html` field in renders (alternative to `preview_url`)
