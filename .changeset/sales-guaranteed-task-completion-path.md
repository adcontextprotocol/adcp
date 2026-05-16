---
---

fix(compliance): sales_guaranteed/create_media_buy — use `task_completion.media_buy_id` `context_outputs` path

The `create_media_buy` step in this storyboard exercises the spec-correct guaranteed-seller flow: returns an A2A task envelope (`status: 'submitted'`, no `media_buy_id` yet); the seller-assigned id only materializes on the eventual task-completion artifact after IO signing.

The fixture's `context_outputs[0].path` was bare `"media_buy_id"`, which the runner resolves against the immediate submitted-arm response — where the field doesn't exist yet — producing `capture_path_not_resolvable` and breaking downstream phases that depend on `$context.media_buy_id`.

Updates the path to `"task_completion.media_buy_id"` so the runner polls `tasks/get` and captures the seller-issued id from the terminal artifact, per the runner contract introduced in adcp-client#1426 (commit `3b21a15a`).

Non-protocol (storyboard fixture only). No version bump.
