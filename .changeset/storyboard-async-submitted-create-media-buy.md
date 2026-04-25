---
---

compliance: add create_media_buy async submitted → completed storyboard (cross-transport)

Adds `static/compliance/source/protocols/media-buy/scenarios/create_media_buy_async_submitted.yaml` —
a new compliance scenario that exercises the `submitted` task envelope for `create_media_buy` and the
`submitted → completed` lifecycle, filling the gap flagged in `adcp-client#904`.

**What this scenario asserts (MCP transport, runnable now):**
- `create_media_buy` returns `status: submitted` with `task_id` and without `media_buy_id` or `packages`
- `response_schema` validates the `CreateMediaBuySubmitted` discriminated-union branch
- After controller-driven task completion, `get_media_buys` shows a live `media_buy_id` with `confirmed_at`

**Cross-transport wire-shape invariants (documented, A2A assertions pending adcp-client#904):**
- A2A: `Task.state === 'completed'` (HTTP call completed; AdCP task is queued)
- A2A: `artifact.metadata.adcp_task_id` carries the AdCP async handle
- A2A: `artifact.parts[0].data.status === 'submitted'`

These are protocol-level decisions from adcp-client#899. Without this storyboard an agent regressed
to the pre-#899 A2A shape (top-level `Task.state: 'submitted'`, `adcp_task_id` in `data` instead of
`metadata`) would still pass the suite.

**Wiring:** added to `sales-guaranteed/index.yaml` `requires_scenarios` since that specialism is the
natural home for sellers that implement the async IO-approval / submission flow.

**Changeset type:** `--empty` (no protocol spec change; compliance suite addition only).

Closes #3081.
