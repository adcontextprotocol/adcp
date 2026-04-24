---
---

Triage routine now runs a mandatory pre-PR build + test gate (npm run precommit or equivalent) before expert review, with 2 build→fix iterations. Also elevates bullet-label boundary framing ("**X gaps**") from CI warning to hard error in the current-context lint, and adds an explicit rule to the context-refresh prompt.
