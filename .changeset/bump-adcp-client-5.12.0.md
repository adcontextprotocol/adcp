---
---

Bump `@adcp/client` from 5.11.0 to 5.12.0.

Also flips `tsconfig.json` from `strict: false` to `strict: true`, matching
`server/tsconfig.json` (which has always been strict — it's the config CI
uses via `npm run typecheck`). This makes local `npx tsc --noEmit` and IDE
type-checking behave the same as CI. Zero code changes required — the
codebase already passes under `--strict`.

Removes a class of latent discriminated-union narrowing issues where
`!result.ok` wouldn't narrow a `{ ok: true; … } | { ok: false; … }` union
under the old `strict: false` config.
