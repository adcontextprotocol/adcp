---
---

Addie: sanitize agent-controlled error and narrative strings before interpolating them into MCP tool output. Closes #3219.

The hint fix-plan formatter (adcp#3084 / #3220) carefully sanitized every seller-controlled field at its boundary, but sibling renders on the same `StoryboardStepResult` (`step.error`, `validation.error`, `result.next.narrative`) and adjacent tools (`evaluate_agent_quality` scenario errors, `compare_media_kit` per-brief errors, `test_io_execution` failure messages, `get_storyboard_detail` narratives) emitted runner/agent strings raw — letting a hostile or compromised seller bypass the formatter's prompt-injection protection through a sibling field on the same Claude-bound output.

This pass runs every such site through `sanitizeAgentField` with a documented 400-char cap (`RUNNER_ERROR_MAX_LEN`) — explicitly framed as a prompt-injection budget, not a UX choice. Defense in depth; no current attack.
