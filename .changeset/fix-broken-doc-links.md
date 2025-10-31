---
"adcontextprotocol": patch
---

Fix broken documentation links by adding .mdx file extensions.

All internal documentation links were missing the `.mdx` file extension, causing 404 errors when users clicked them. This fix adds the proper `.mdx` extension to 181 internal links across 26 documentation files, ensuring all navigation links work correctly.

Fixes #167
