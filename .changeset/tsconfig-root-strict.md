---
---

Flip root `tsconfig.json` from `strict: false` → `strict: true` to match
`server/tsconfig.json` (the config CI uses via `npm run typecheck`).

The root config is used by IDEs and local `npx tsc --noEmit`. Leaving it
loose meant local/IDE typing diverged from CI — in particular, TS 5.9
won't narrow `!result.ok` on boolean-literal discriminated unions without
`strictNullChecks`, producing false errors locally while CI was fine.

Zero code changes required — the codebase already passes under `--strict`.
