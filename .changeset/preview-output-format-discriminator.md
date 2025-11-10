---
"adcontextprotocol": patch
---

Add output_format discriminator to preview render schema for improved validation performance.

Replaces oneOf constraint on render objects with an explicit output_format field ("url", "html", or "both") that indicates which preview fields are present. This eliminates the need for validators to try all three combinations when validating preview responses, significantly improving validation speed for responses with multiple renders (companion ads, multi-placement formats).

**Schema change:**
- Added required `output_format` field to render objects in preview-creative-response.json
- Replaced `oneOf` validation with conditional `allOf` based on discriminator value
- Updated field descriptions to reference the discriminator

**Backward compatibility:**
- Breaking change: Existing preview responses must add the output_format field
- Creative agents implementing preview_creative task must update responses
