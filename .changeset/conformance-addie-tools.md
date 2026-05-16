---
---

feat(addie): conformance Socket Mode chat tools (PR #3 of 3) — `issue_conformance_token` and `run_conformance_against_my_agent`. Adopters mapped to a WorkOS organization can ask Addie for a token, paste it into their `@adcp/sdk/server` ConformanceClient, then have Addie run a storyboard against their dev MCP server with results rendered as a markdown report in chat. Gated on `CONFORMANCE_SOCKET_ENABLED=1` so the chat surface stays dark until ops opts in. Server-side WS plumbing (PR #1) and storyboard runner adapter (PR #2) remain always-wired.
