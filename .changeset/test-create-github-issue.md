---
---

Let Addie file GitHub issues as the member via WorkOS Pipes instead of a bot token. `create_github_issue` now pulls a per-user GitHub access token from Pipes; if the user hasn't connected yet (or scopes changed) it returns a Connect URL alongside the `draft_github_issue` fallback. Member hub gains a Connections card with a "Connect GitHub" button backed by new `/api/me/connected-accounts/github` routes.
