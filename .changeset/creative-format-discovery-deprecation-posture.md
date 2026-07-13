---
"adcontextprotocol": patch
---

Document the 3.2 creative-format discovery deprecation posture and relax conformance so agents that declare equivalent canonical-format discovery are not required to expose `list_creative_formats`. Buyers MUST NOT assume the v1 discovery tool when canonical discovery is declared. `list_creatives` remains the creative-library query task; v1 `format_id` / `format_ids[]` remain supported through 4.x. Compliance storyboard steps that call `list_creative_formats` are gated with `requires_tool` so migrated agents grade those steps `not_applicable` rather than failing.
