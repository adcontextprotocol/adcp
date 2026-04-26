---
---

Closes #3304: dynamic per-context labels and prompts for Addie's suggested-prompts engine. `PromptRule.label` and `.prompt` now accept `string | (ctx) => string`. Resolves at evaluation time. Dynamic-prompt rules opt into a `matchClick` callback for click telemetry since the static reverse-index can't represent function strings. Cert continuation now renders "Continue A1" / "Let's keep going with A1. Where did we leave off?" when module_id is known, falling back to track_id ("Continue A") and the original generic phrasing when neither is present.
