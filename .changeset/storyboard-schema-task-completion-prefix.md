---
---

docs(storyboard-schema): document the `task_completion.<inner>` prefix for `context_outputs[].path`. When the immediate response is a non-terminal task envelope (`submitted`/`working`/`input-required`), the runner polls `tasks/get` until terminal and resolves the suffix against the completion artifact's `data` — needed for captures like seller-assigned `media_buy_id` on IO-signing flows. Requires runner >= adcp-client v6.7. Closes #3950.
