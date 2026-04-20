---
"adcontextprotocol": minor
---

Three pre-4.0 DX fixes surfaced during Python SDK v4.0.0-rc validation:

- **sync_creatives response**: add optional `status: CreativeStatus` to per-item results so buyers learn approval/review state without a follow-up `list_creatives`; add a third top-level `SyncCreativesSubmitted` shape (`status: "submitted"` + `task_id`) mirroring the `create_media_buy` three-shape pattern for when the whole sync is queued asynchronously; enforce "no `status` when `action` is `failed`/`deleted`" via conditional validation (issue #2428). The item-level constraint uses draft-07 `if/then`, which many code generators (openapi-typescript, pre-0.25 datamodel-code-generator, quicktype, Zod via `zod-to-json-schema`) ignore — generated types will emit `status` as always-optional and miss the invariant. Consumers should add a runtime check: "status MUST be omitted when action=failed/deleted" on sync items.
- **get_adcp_capabilities idempotency**: add `adcp.idempotency.supported: boolean` and model the block as a two-branch discriminated `oneOf` on that field — `IdempotencySupported` (discriminator `supported: true`, `replay_ttl_seconds` required) and `IdempotencyUnsupported` (discriminator `supported: false`, `replay_ttl_seconds` forbidden via `not`). Sellers without replay dedup can now declare it explicitly instead of emitting an ambiguous empty block. The discriminator lets code generators emit two named types with the invariant enforced at the type level, avoiding the draft-07 `if/then` ergonomics trap where most generators silently drop the constraint (issue #2429, closes #2436).

  Before (3.0.0-rc.3):
  ```json
  { "idempotency": {} }
  ```
  After (this RC) — supported seller:
  ```json
  { "idempotency": { "supported": true, "replay_ttl_seconds": 86400 } }
  ```
  After (this RC) — unsupported seller:
  ```json
  { "idempotency": { "supported": false } }
  ```
- **Error codes**: add `CREATIVE_NOT_FOUND` and `SIGNAL_NOT_FOUND` to the `error-code` enum to match the existing `PRODUCT_NOT_FOUND` / `MEDIA_BUY_NOT_FOUND` / `PACKAGE_NOT_FOUND` pattern (issue #2430).

**RC-breaking note**: `adcp.idempotency` is now a discriminated `oneOf` with `supported` required as the discriminator. Sellers that shipped against `3.0.0-rc.3` (which emitted an empty `idempotency: {}` block) and against the interim source which required `replay_ttl_seconds` without `supported` will need to regenerate their capabilities response and pick a branch: `{ supported: true, replay_ttl_seconds: N }` or `{ supported: false }`. The empty-block form is no longer valid. SDKs consumed via `adcp-client-python` v4.0.0-rc and `@adcp/client` should regenerate schemas against the new RC. Buyers validating captured `3.0.0-rc.3` responses against the new schemas will see validation failures on the missing `supported` field — pin validator to the matching RC version. If you hand-wrote your validator, the only change is checking `supported` first; if you used `openapi-typescript`, `datamodel-code-generator`, or similar, regenerate and you'll get two named types (`IdempotencySupported`, `IdempotencyUnsupported`) you can discriminate on. **Strict validation is now the safe default** for sync_creatives responses (the new item-level conditional on `status` and the three-shape `oneOf` catch seller misbehavior that lagging validators would silently accept); buyers on stale validators SHOULD upgrade before relying on per-item `status`.
