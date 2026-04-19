---
"adcontextprotocol": minor
---

Three pre-4.0 DX fixes surfaced during Python SDK v4.0.0-rc validation:

- **sync_creatives response**: add optional `status: CreativeStatus` to per-item results so buyers learn approval/review state without a follow-up `list_creatives`, and add a third top-level `SyncCreativesSubmitted` shape (`status: "submitted"` + `task_id`) mirroring the `create_media_buy` three-shape pattern for when the whole sync is queued asynchronously (issue #2428).
- **get_adcp_capabilities idempotency**: add `adcp.idempotency.supported: boolean` (required) mirroring the `request_signing.supported` pattern, with `replay_ttl_seconds` conditionally required only when `supported: true`. Sellers without replay dedup can now declare it explicitly instead of emitting an ambiguous empty block (issue #2429).
- **Error codes**: add `CREATIVE_NOT_FOUND` and `SIGNAL_NOT_FOUND` to the `error-code` enum to match the existing `PRODUCT_NOT_FOUND` / `MEDIA_BUY_NOT_FOUND` / `PACKAGE_NOT_FOUND` pattern (issue #2430).
