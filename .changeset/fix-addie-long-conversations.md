---
---

fix: Addie long conversation accuracy, context management, and tooling

- Keep knowledge tools (search_docs, search_repos) during certification sessions for protocol verification
- Fix escalation thread_id null for web/voice conversations
- Upgrade Sonnet/Opus context limits to 1M tokens, default 50 messages, compaction for all conversations
- Add protocol accuracy rules to fallback prompt and certification context
- Preserve knowledge search results during context compaction
- Add context warning with dropped message summary for long conversations
- New request_working_group_invitation tool for private group access
- join_working_group pre-checks visibility before attempting
- New create_github_issue tool with auth, repo allowlist, and user attribution
- Add UCP/ARTF/OpenRTB/MCP/A2A search synonyms
