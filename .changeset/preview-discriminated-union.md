---
"adcontextprotocol": "patch"
---

Add discriminator fields to preview_creative request and response schemas.

**Changes:**
- Added `request_type` discriminator to preview-creative-request.json ("single" | "batch")
- Added `response_type` discriminator to preview-creative-response.json ("single" | "batch")

**Why:**
Explicit discriminator fields enable TypeScript generators to produce proper discriminated unions with excellent type narrowing and IDE autocomplete. Without discriminators, generators produce index signatures or massive union types with poor type safety.

**Migration:**
Request format:
```json
// Before
{ "format_id": {...}, "creative_manifest": {...} }

// After (single)
{ "request_type": "single", "format_id": {...}, "creative_manifest": {...} }

// Before
{ "requests": [...] }

// After (batch)
{ "request_type": "batch", "requests": [...] }
```

Response format:
```json
// Before
{ "previews": [...], "expires_at": "..." }

// After (single)
{ "response_type": "single", "previews": [...], "expires_at": "..." }

// Before
{ "results": [...] }

// After (batch)
{ "response_type": "batch", "results": [...] }
```
