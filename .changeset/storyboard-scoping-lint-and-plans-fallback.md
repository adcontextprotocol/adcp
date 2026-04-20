---
---

Storyboard scoping guardrails + runtime fallback for session-scoped tasks (#2527, #2529, #2531).

- Add `scripts/lint-storyboard-scoping.cjs` and wire into `npm run build:compliance`. Every step invoking a tenant-scoped task (defined by `TENANT_SCOPED_TASKS`) must carry brand/account identity in `sample_request`, or land in `open:default` and silently fork sessions from subsequent branded reads. Fix 26 pre-existing violations across 10 storyboards by adding `brand: { domain }` from each storyboard's `test_kit`. (#2527)
- Add `tests/lint-storyboard-scoping.test.cjs` parity test. Parses the training-agent `HANDLER_MAP` and asserts every registered task appears in exactly one of `TENANT_SCOPED_TASKS` / `EXEMPT_FROM_LINT`. Prevents silent drift when new tools are added without updating the classification. Wired into `npm run test` as `test:storyboard-scoping`. (#2529)
- Extend `sessionKeyFromArgs` in `server/src/training-agent/state.ts` to fall back to `plans[0].brand.domain` before `open:default`. `sync_plans` calls carry brand identity inside the plans array, not at the envelope level — without this fallback, governance storyboards that only identify the tenant via plans land in the wrong session. Matches what the scoping lint already accepts as a valid identity shape. (#2531)
- Authoring guide at `docs/contributing/storyboard-authoring.md` documents the scoping rule, valid identity shapes, the `scoping: global` opt-out for intentionally cross-tenant probes, and how to run the lint locally.
