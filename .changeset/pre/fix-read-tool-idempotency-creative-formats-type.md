---
"adcontextprotocol": patch
---

Stop the universal `read_tool_idempotency` storyboard from sending the creative-agent-only `type` filter to `list_creative_formats`, avoiding spurious `input_schema_field_stripped` notices when the target is a media-buy agent.
