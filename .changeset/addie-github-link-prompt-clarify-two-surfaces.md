---
---

When the user has no `github_username` on their community profile, Addie's member-context prompt now names both GitHub surfaces with their exact URLs instead of one ambiguous nudge: profile-display field at `https://agenticadvertising.org/account` and OAuth connection at `https://agenticadvertising.org/connect/github` (the bouncer added in #3577). Reduces the chance of Addie paraphrasing the path and handing users a URL that doesn't exist.
