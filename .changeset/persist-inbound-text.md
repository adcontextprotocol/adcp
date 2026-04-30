---
---

`message_received` person_events now persist the inbound text alongside `text_length` (mirroring what `message_sent` already stores). This unblocks "find this thread, see what's missing"-shaped diagnostics — Addie can now read the full conversation from her own timeline instead of seeing only outbound messages. Web chat writes use `inputValidation.sanitized` so the entry inherits the existing prompt-injection / flagging pipeline; Slack writes use the same sanitized variant. A 64KB byte cap with a `truncated: true` flag prevents a single large paste from inflating timeline reads. Closes #3580.
