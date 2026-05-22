---
"adcontextprotocol": patch
---

fix(training-agent): thread `dry_run` and `assignments[]` through v6 platform shims via `ctx.input`.

The v6 SDK's typed `SalesPlatform.syncCreatives`, `AudiencePlatform.syncAudiences`, and `AccountStore.upsert` signatures destructure the request envelope and pass only the typed first-arg (`creatives[]` / `audiences[]` / `refs[]`) to the platform method — fields like `dry_run` and inline `assignments[]` were dropped on the v6 path while the legacy `/mcp` route preserved them (adcp-client#1842). 7.8 fixed this by exposing the original envelope as `ctx.input: Readonly<Record<string, unknown>>`; this change lifts the dropped fields back out for our v5-shimming v6 platforms.

Adopted in:

- `v6-sales-platform.ts` and `v6-creative-platform.ts` and `v6-creative-builder-platform.ts` — `syncCreatives` now threads `dry_run` (suppresses session persistence) and `assignments[]` (writes inline package bindings) through to `handleSyncCreatives`. The v6 response signature returns only `SyncCreativesRow[]`, so assignment results are observable via subsequent `get_media_buys` rather than in the sync response itself.
- `v6-account-helpers.ts` — `syncAccountsUpsert` threads `dry_run` to `handleSyncAccounts`. `delete_missing` is on the SDK's drop list but the v5 handler doesn't implement it yet, so threading it would be inert — wire when v5 grows support.

Helper `pickFromInput` in `v6-input-helpers.ts` does the named-field lift; per SDK guidance, `ctx.input` is buyer-controlled and untrusted, so the helper reads only named fields and never logs wholesale.
