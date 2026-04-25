---
---

CI: better DX when the Training Agent Storyboards floor gate trips. The `::error::` line now spells out the exact file + matrix key to edit, the storyboards.log is uploaded as an artifact on failure so you can see *which* storyboards regressed without rerunning locally, and the bash steps gain `set -euo pipefail` plus an explicit empty-check on metric extraction so a future log-format change fails loudly with a name instead of a cryptic `[: unary operator expected`. Adds a defense-in-depth `::warning::` (not a hard fail) when the framework-vs-legacy passing-step asymmetry inverts. Closes #3214.
