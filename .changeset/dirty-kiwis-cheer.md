---
---

Improve Addie router intelligence and search observability

**Router improvements:**
- Add `usage_hints` field to AddieTool interface for router-specific guidance
- Router now builds tool descriptions from tool definitions (no duplication)
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

**Prompt improvements:**
- Strengthen GitHub issue drafting instructions - users cannot see tool outputs
- Add conversation context maintenance guidance to prevent entity substitution

**Bug fixes:**
- Fix DM Assistant thread context loss - now fetches conversation history from database
- Previous messages are passed to Claude so it maintains context across turns

**Member insights integration:**
- Router now uses member insights (role, interests, pain points) for smarter tool selection
- Fetch member context and insights in parallel for better performance
- Add in-memory cache with 30-minute TTL (long since we invalidate on writes)
- Prefetch insights when user opens Addie (before first message)
- Auto-invalidate cache when new insights are extracted or added via admin API

**Performance optimizations:**
- Add 30-minute cache for admin status checks (isSlackUserAdmin)
- Admin status rarely changes and was being checked multiple times per conversation
- Add 30-minute cache for active insight goals (only 2 possible variants: mapped/unmapped)
- Auto-invalidate goals cache on goal create/update/delete via admin API
- Add 30-minute cache for Slack channel info (names/purposes rarely change)

**Previous work (already in PR):**
- Log router decisions to unified thread messages
- Add config versioning for feedback analysis by configuration
