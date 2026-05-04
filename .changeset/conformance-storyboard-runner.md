---
---

feat(addie): conformance Socket Mode — storyboard runner adapter (PR #2 of 3). Adds `runStoryboardViaConformanceSocket(orgId, storyboardId)` that resolves a live conformance session, wraps its MCP client as an `AgentClient` via the SDK's existing `AgentClient.fromMCPClient` factory, and dispatches to the standard storyboard runner via the `_client` injection seam. Zero changes to existing storyboard infrastructure; this is a separate runner that picks the same storyboards from the same registry. PR #3 adds the Addie chat tools that consume it.
