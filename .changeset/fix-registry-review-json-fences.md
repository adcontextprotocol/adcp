---
---

Fix Addie registry review JSON parse crash when the model wraps its verdict in
markdown code fences (e.g. ```` ```json ... ``` ````). The review now tolerates
fenced responses and falls back to extracting the first `{...}` block from the
text, so community edits no longer trigger the `Unexpected token '`'` error.
