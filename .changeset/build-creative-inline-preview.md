---
"adcontextprotocol": minor
---

Add optional inline preview to build_creative. Request can set `include_preview: true` to get preview renders in the response alongside the manifest. The preview structure matches preview_creative's single response, so clients parse previews identically regardless of source. For single-format requests, `preview_inputs` controls variant generation. For multi-format requests, one default preview per format is returned with explicit `format_id` on each entry. `preview_error` uses the standard error structure (`code`, `message`, `recovery`) for agent-friendly failure handling. Agents that don't support inline preview simply omit the field.
