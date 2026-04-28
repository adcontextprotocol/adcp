---
"adcontextprotocol": minor
---

feat(schema): add `Submitted` arm to per-tool response `oneOf` for `update_media_buy`, `build_creative`, and `sync_catalogs` (#3392)

AdCP 3.0 shipped `*-async-response-submitted.json` schemas for 6 HITL tools but only 2 of 6 per-tool `xxx-response.json` schemas included the `Submitted` arm in their top-level `oneOf`. This left SDK codegen unable to generate typed `*Task` HITL methods for the 4 missing tools.

This changeset fixes 3 of the 4 gaps (the `get_products` case is flagged for human review — see #3392):

- `update-media-buy-response.json` — adds `UpdateMediaBuySubmitted` arm (`status: "submitted"` + `task_id`); updates `UpdateMediaBuyError.not` to exclude the submitted state
- `build-creative-response.json` — adds `BuildCreativeSubmitted` arm; updates `BuildCreativeError.not` to exclude the submitted state
- `sync-catalogs-response.json` — adds `SyncCatalogsSubmitted` arm; updates `SyncCatalogsError.not` to exclude the submitted state

Non-breaking: existing `Success | Error` consumers are unaffected. Buyers gain a new permitted response shape and SDK codegen can produce typed HITL methods for these three tools.

Note: the fix uses the same inline arm pattern as `create-media-buy-response.json` and `sync-creatives-response.json` — not `$ref` to the `*-async-response-submitted.json` schemas (those are task-completion artifact payloads for the webhook path, not the initial-response discriminated arm).

Closes partial scope of #3392.
