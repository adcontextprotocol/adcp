---
---

Stop Addie from hallucinating that GitHub issue filing is unavailable in Slack threads. `create_github_issue` joins `draft_github_issue` in `ALWAYS_AVAILABLE_TOOLS`, the content tool-set description no longer claims ownership of GitHub issuing, and the unavailable-sets hint now explicitly enumerates always-available escape hatches. Also tightens `draft_github_issue` so Addie can't invent non-existent repo names, and points the Connect-GitHub fallback at the actual `/member-hub` page.
