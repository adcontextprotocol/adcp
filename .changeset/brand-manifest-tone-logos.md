---
"adcontextprotocol": minor
---

Add structured tone guidelines and standardized logo tags to Brand Manifest schema.

**Tone field changes:**
- Now supports both simple string (backward compatible) and structured object
- Structured tone includes `voice`, `attributes`, `dos`, and `donts` fields
- Enables creative agents to generate brand-compliant copy programmatically

**Logo object changes:**
- Added `usage` field for human-readable usage descriptions
- Documented standardized tag vocabulary:
  - Background: `dark-bg`, `light-bg`, `transparent-bg`
  - Orientation: `square`, `horizontal`, `vertical`, `stacked`
  - Context: `primary`, `secondary`, `icon`, `wordmark`, `full-lockup`

Closes #945
