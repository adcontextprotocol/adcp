---
---

Improve Addie router intelligence and search observability

**Router improvements:**
- Add tool descriptions to router prompt so it picks tools based on query intent (not just keywords)
- Distinguish "how does X work?" (search_docs) from "validate my X" (validate_adagents)
- Separate expertise areas for validation vs learning questions

**Docs indexing:**
- Extract markdown headings as separate searchable artifacts
- Generate anchor links for deep linking to specific sections
- Build headings index alongside docs index (1659 headings from 100 docs)

**Search tracking:**
- Log all search queries for pattern analysis
- Track results count, latency, and tool used
- Enable content gap detection via zero-result query analysis

**Previous work (already in PR):**
- Log router decisions to unified thread messages
- Add config versioning for feedback analysis by configuration
