---
---

Document the level convention in `server/src/logger.ts` JSDoc: `error`/`fatal` (level >= 50) trigger Slack `#aao-errors` alerts and PostHog `$exception` capture via the pino hook, so they should be reserved for unexpected, page-worthy failures. For *expected* failures with a graceful user-facing fallback (third-party 4xx, validation errors, etc.), use `warn` so the alert path is not taken.

This is a docs-only change to give future authors and reviewers a clear reference for the `logger.error` vs `logger.warn` decision. The same anti-pattern triggered the original `:rotating_light: System error: unknown` Slack noise that PRs #3578 / #3622 / #3648 fixed.
