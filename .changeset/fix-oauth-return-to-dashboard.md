---
---

fix(oauth): redirect back to originating page after agent OAuth completes

The agent OAuth callback previously landed on a terminal `oauth-complete.html`
page asking the user to close the tab. When the flow was initiated from the
dashboard, the user was stranded instead of returning to their work.

`/api/oauth/agent/start` now accepts a same-origin `return_to` path, persists
it with the pending flow, and forwards it to the success page. The dashboard
passes its current path so the success page auto-redirects back after a brief
confirmation. The Slack / MCP entry points omit `return_to`, preserving the
existing "close this tab" behavior for those contexts.
