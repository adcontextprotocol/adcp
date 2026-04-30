---
---

Switch 43 Addie source files from the root `logger` import to `createLogger('<module-name>')` so error logs from these modules are attributed in the `#aao-errors` Slack channel and PostHog `$exception` events. Without a `module` binding, the pino error hook in `server/src/utils/posthog.ts:245` was falling through to `module || 'unknown'`, which is why operators were seeing `:rotating_light: System error: unknown [web]` for the bulk of error-level alerts. No behavioral change beyond log attribution; child pino loggers are signature-compatible with the root.

Module names follow the existing convention by directory: `addie/<file>.ts` → `addie-<basename>`, `addie/mcp/<file>.ts` → `addie-<basename>`, `addie/jobs/<file>.ts` and `addie/services/<file>.ts` → bare `<basename>`, `addie/home/<file>.ts` → `addie-home-<basename>`, `addie/home/builders/<file>.ts` → `addie-home-builder-<basename>`, `addie/rules/index.ts` → `addie-rules`.
