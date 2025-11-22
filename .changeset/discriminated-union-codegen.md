---
"adcontextprotocol": minor
---

Improve TypeScript and Zod code generation for discriminated union schemas.

**Changes:**
- Moved common fields (`ext`, `context`) inside each `oneOf` variant instead of at root level
- Affected schemas (10 total):
  - Creative schemas: `preview-creative-request.json`, `preview-creative-response.json`, `build-creative-response.json`
  - Media buy schemas: `create-media-buy-response.json`, `update-media-buy-response.json`, `sync-creatives-response.json`, `provide-performance-feedback-response.json`
  - Signal schemas: `activate-signal-response.json`

**Benefits:**
- Enables automatic Zod schema generation with `ts-to-zod` (previously failed on intersection types)
- Produces clean discriminated union types instead of intersection types
- Better TypeScript developer experience with proper type narrowing and IDE autocomplete
- Reduces manual Zod schema maintenance burden
- Consistent pattern across all discriminated union response/request schemas

**Backward Compatibility:**
- Runtime validation behavior is identical
- No API breaking changes
- Generated TypeScript types have same semantic meaning, just cleaner structure

**Migration:**
For SDK maintainers:
1. Regenerate TypeScript types from updated schemas
2. Regenerate Zod schemas (now works automatically with `ts-to-zod`)
3. Remove manual Zod schemas for affected types
4. No changes needed for API consumers - types are compatible
