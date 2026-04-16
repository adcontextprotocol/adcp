---
---

docs: add v2 sunset page and 3.x stability guarantees (issues #2220, #2221)

- New `docs/reference/v2-sunset.mdx` documents v2 unsupported as of 3.0 GA, security-only patches through August 1 2026, full deprecation thereafter, and AAO certification/verification policy
- `docs/reference/versioning.mdx` gains a "3.x stability guarantees" section covering field/enum/error/task guarantees, patch-level semantics, security-fix posture, and breaking-change notice requirements
- Migration guide index gains a v2-unsupported warning and links to the sunset page; fixes a contradiction about version negotiation
- Release notes link to both pages
