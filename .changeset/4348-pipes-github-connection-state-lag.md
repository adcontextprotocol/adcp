---
---

fix(addie): resolve one-turn GitHub connection lag after WorkOS Pipes OAuth completion

`getGitHubAccessToken` now retries once after 1.5 s when the Pipes API returns `not_installed`, absorbing the propagation window between OAuth callback and token availability. The `create_github_issue` tool's fallback message now tells users the connection may still be propagating so they know to retry rather than reconnect. The tool's `usage_hints` instruct Addie not to re-show the Connect link if the user just completed OAuth in the same conversation thread.

Closes #4348.
