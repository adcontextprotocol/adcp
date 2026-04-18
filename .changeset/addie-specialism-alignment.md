---
---

Align Addie and the registry API with the 5.1.0 capability-driven compliance model.

`recommend_storyboards` (MCP) and `GET /api/registry/agents/{encodedUrl}/applicable-storyboards` (REST) now probe `get_adcp_capabilities` and call `resolveStoryboardsForCapabilities` instead of tool-matching against `required_tools`. The agent's declared `supported_protocols` and `specialisms` are the source of truth; the runner returns universal + domain baselines + declared specialism bundles, grouped by bundle kind.

When an agent doesn't declare capabilities, Addie coaches the developer on what to add to their `get_adcp_capabilities` response — no per-org "expected specialisms" state, no extra selection tool. If a declared specialism isn't in the local compliance cache, the REST endpoint returns 422 with `unknown_specialism: true` so the UI can prompt a cache re-sync.

Addie's system prompt updated to frame the new flow: probe → recommend → run, and "don't invent a parallel concept — the agent declares what it supports."
