---
"adcontextprotocol": minor
---

Add optional inline preview to build_creative. Request can set `include_preview: true` to get preview renders in the response alongside the manifest. The preview structure matches preview_creative's single response, so clients parse previews identically regardless of source. Agents that don't support inline preview simply omit the field.
