---
---

docs(tasks/get): remove non-existent `include_result` flag from polling examples and clarify 3.0 completion-payload retrieval

The `tasks/get` request schema (`static/schemas/source/core/tasks-get-request.json`) does not define an `include_result` field, and the response schema (`static/schemas/source/core/tasks-get-response.json`) does not define a `result` field. Five doc files were inviting buyers to send `include_result: true` and read a typed completion payload off the polled response — neither of which is supported by the 3.0 spec.

Removed the spurious parameter from the polling examples in `task-lifecycle.mdx`, `async-operations.mdx` (two call sites), `error-handling.mdx`, and `orchestrator-design.mdx`. Added a note on the canonical `task-lifecycle` polling section stating that in 3.0, `tasks/get` returns task status and the completion payload (e.g. `media_buy_id`, `packages` from `create_media_buy`) is delivered via the seller's push notification to the buyer's webhook URL configured in `push_notification_config`. Buyers that need the completion payload MUST configure a webhook in 3.0; polling alone reports terminal status.

A typed `include_result` request flag and a documented response projection on completion are tracked for 3.1 in #3123. This patch corrects the docs to match what 3.0 actually ships; the schema-additive fix is out of scope per the patch policy in `docs/reference/versioning.mdx` ("Patches never change schema — no new fields, no renamed fields, no new enum values").
