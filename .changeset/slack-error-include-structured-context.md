---
---

ops(slack-errors): include structured-log context in #aao-errors notifications

Error-channel Slack posts now render the structured fields from `logger.error({ ... }, msg)` calls (e.g. HTTP `status`, `domain`, `agentUrl`, `task`) under the message, with `module`/`processRole`/secrets stripped. Previously only the message string and stack trace made it to Slack — operators had to dig into PostHog to see the actual status code or resource path that triggered the alert.

Also gives `server/src/addie/mcp/adcp-tools.ts` a module-scoped logger so its errors surface as `System error: adcp-tools` instead of `unknown`.
