---
---

fix(registry-api): downgrade external agent fetch failures from error to warn

`/public/agent-formats` and `/public/agent-products` were logging upstream-agent failures at `error` severity, which paged operators for problems we can't fix (e.g., a non-conformant third-party MCP agent that returns prose-wrapped JSON instead of `structuredContent`).

These are upstream issues, not our system erroring — log at `warn` and return 502 (bad gateway) instead of 500 so it's clear who owns the fix.
