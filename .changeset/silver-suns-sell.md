---
"adcontextprotocol": minor
---

Implement unified thread model and Slack Bolt integration for Addie.

**New Features:**
- Unified thread service that consolidates conversations across all channels (Slack, Web, A2A)
- Slack Bolt integration with streaming responses and Assistant API support
- Server-Sent Events (SSE) streaming for web chat
- Enhanced admin dashboard with unified thread view across channels

**Technical Changes:**
- New `addie_threads` and `addie_thread_messages` tables with proper indexes
- `ThreadService` class with UPSERT-based thread creation for concurrent safety
- `AddieClaudeClient` with async generator streaming support
- SSE connection handling with disconnect detection
- Feedback buttons in Slack responses

**Migrations:**
- 060: Thread context store for Slack Bolt
- 061: Unified threads schema with views and triggers
- 062: Data migration from legacy tables
