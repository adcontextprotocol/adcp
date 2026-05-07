---
---

Addie's `get_github_issue` tool now accepts an `include_diff` flag (returns the unified PR diff via `application/vnd.github.v3.diff`) and reads from any public GitHub repo, not just `adcontextprotocol/*` and `prebid/*`. Closes the diff-blindness gap and the fork-access gap that blocked code review on contributor-fork PRs. The full github-mcp-server migration is tracked separately in #4181.
