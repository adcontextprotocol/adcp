---
"adcontextprotocol": patch
---

Fix broken documentation links for Mintlify deployment.

Converted all relative internal links to absolute Mintlify-compatible paths with `/docs/` prefix. This fixes 389 broken links across 50 documentation files that were causing 404 errors when users clicked them on docs.adcontextprotocol.org.

**Technical details:**
- Changed relative paths like `./reference/release-notes` to absolute `/docs/reference/release-notes`
- Mintlify requires absolute paths with `/docs/` prefix and no file extensions
- Links now match Mintlify's URL structure and routing expectations

Fixes #167
