---
"adcontextprotocol": minor
---

Deprecate FormatCategory enum and make `type` field optional in Format objects

The `type` field (FormatCategory) is now optional on Format objects. The `assets` array is the authoritative source for understanding creative requirements.

**Rationale:**
- Categories like "video", "display", "native" are lossy abstractions that don't scale to emerging formats
- Performance Max spans video, display, search, and native simultaneously
- Search ads (RSA) are text-only with high intent context - neither "display" nor "native" fits
- The `assets` array already provides precise information about what asset types are needed

**Migration:**
- Existing formats with `type` field continue to work
- New formats may omit `type` entirely
- Buyers should inspect the `assets` array to understand creative requirements
