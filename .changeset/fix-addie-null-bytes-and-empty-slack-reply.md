---
---

fix(addie): strip U+0000 from thread message inserts and avoid empty Slack postMessage in active thread replies

Two related Slack failures observed in production:

1. `ThreadService.addMessage` was rejecting inserts with `unsupported Unicode escape sequence` when a tool result contained a null byte. Postgres TEXT/JSONB both reject U+0000, so we now strip null bytes from `content`, `content_sanitized`, `flag_reason`, `email_message_id`, the `tools_used` array, and the JSON-stringified `tool_calls` / `router_decision` fields before insertion.
2. `handleActiveThreadReply` was calling `chat.postMessage` with an empty `text` when the model produced no usable output, causing Slack to return `no_text`. The active-thread reply path now falls back to the same apology used elsewhere in the bolt app instead of sending an empty message.
