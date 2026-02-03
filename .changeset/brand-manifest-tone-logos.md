---
"adcontextprotocol": minor
---

Add structured tone guidelines and structured logo fields to Brand Manifest schema.

**Tone field changes:**
- Now supports both simple string (backward compatible) and structured object
- Structured tone includes `voice`, `attributes`, `dos`, and `donts` fields
- Enables creative agents to generate brand-compliant copy programmatically

**Logo object changes:**
- Added `orientation` enum field: `square`, `horizontal`, `vertical`, `stacked`
- Added `background` enum field: `dark-bg`, `light-bg`, `transparent-bg`
- Added `variant` enum field: `primary`, `secondary`, `icon`, `wordmark`, `full-lockup`
- Added `usage` field for human-readable descriptions
- Kept `tags` array for additional custom categorization

These structured fields enable creative agents to reliably filter and select appropriate logo variants.

Closes #945
