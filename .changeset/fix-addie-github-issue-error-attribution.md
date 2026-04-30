---
---

Fix Addie GitHub-issue tools error logging:

- `server/src/addie/mcp/member-tools.ts` now uses `createLogger('addie-member-tools')` instead of the root logger, so Slack `#aao-errors` alerts get a proper `source` attribution instead of `unknown`.
- `create_github_issue` now includes GitHub's truncated response body in the log context so operators can tell *why* GitHub rejected the request without having to reproduce.
- Downgraded `create_github_issue`, `get_github_issue`, and `list_github_issues` GitHub-API-rejected logs from `error` to `warn`. Each handler already returns a graceful user-facing fallback, so a 4xx from GitHub should not page as a system error. Network/parse failures in those handlers stay at `error`.
