---
"adcontextprotocol": patch
---

Fix Addie not including GitHub issue link in response when using draft_github_issue tool.

Updated the GitHub Issue Drafting rule in the database to emphasize that tool outputs are invisible to users. The rule now explicitly instructs Addie to copy the full tool output (including the GitHub link) into her response text, rather than saying "see the link above" which doesn't work since users cannot see tool outputs.
