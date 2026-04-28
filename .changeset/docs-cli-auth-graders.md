---
---

Adds `docs/building/grading.mdx`, a discoverable reference page for the `@adcp/client` CLI authentication conformance graders (`grade request-signing`, `diagnose-auth`, `signing generate-key`, `signing verify-vector`). These commands shipped in 5.21+ but were not indexed by `search_docs`, causing Addie to fabricate issues requesting tools that already exist. The new page includes frontmatter keywords for grade/evaluate/OAuth/RFC 9421 queries, per-command documentation, and cross-links from `authentication.mdx` and `security.mdx`.
