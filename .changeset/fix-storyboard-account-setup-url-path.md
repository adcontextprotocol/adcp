---
---

**Fixes the IO-approval modelling across storyboards and the media-buy spec.** Two related bugs:

1. **#2270** — storyboard narratives described the IO-signing setup URL as a top-level `setup.url` field on a media buy response. The correct path is `account.setup.url` (nested on the account), since `setup` only exists on `Account`.
2. **#2351** — storyboards and the media-buy spec treated `pending_approval` as a MediaBuy status and/or a task-level synonym for `input-required`. `pending_approval` is **only** a valid value on `Account.status`; it is not in `MediaBuy.status` or `Task.status`.

Adopted **Option B** from #2351: IO review is modelled entirely at the A2A **task** layer. During IO signing, the `create_media_buy` task stays `submitted` and no `media_buy_id` is issued yet. On task completion, the final artifact delivers the `media_buy_id` and the buyer calls `get_media_buys` to confirm the buy is `active`. There is no queryable intermediate "pending_approval" MediaBuy state.

Updates:

- **`sales-guaranteed`** — rewrote the submitted/active flow: `create_media_buy` now returns a task envelope (`status: submitted`, `task_id`) with no `media_buy_id`. Removed the `poll_approval` / `get_media_buys_pending` phase entirely (no addressable MediaBuy during IO review). `confirm_active` narrative updated to show media_buy_id arrives via task completion.
- **`sales-broadcast-tv`** — `create_media_buy` narrative and expected block updated to return a submitted task envelope when traffic-manager review is needed, with an explicit "do NOT use pending_approval media-buy status" note.
- **`sales-social`** — `list_accounts` bullet points at `accounts[].setup.url`.
- **`protocols/media-buy`** — `sync_accounts` narrative/expected clarified; `create_media_buy` phase narrative reworked to drop the "pending_approval with URL" framing and replace with task-layer modelling; `get_media_buys` (check_buy_status) narrative reworked similarly.
- **`docs/media-buy/specification.mdx`** — normative updates: "Asynchronous Operations" bullet, "Orchestrator conformance" list, and the "Human-in-the-Loop" subsection all rewritten to describe approval as task-layer `submitted` / `input-required`, with explicit notes that `pending_approval` exists only on Account.status.
- **`docs/protocol/required-tasks.mdx`** — orchestrator conformance bullet updated to list task-level async states (`submitted`, `working`, `input-required`) instead of `pending_approval`.
- **`docs/media-buy/index.mdx`** — governance walkthrough prose updated to describe the escalation path as task-layer `submitted` / `input-required`, not a MediaBuy pausing at `pending_approval`.
- **`docs/building/implementation/task-lifecycle.mdx`** — "Approval Flow" section: clarified that `pending_approval` is not a task-level status; task-layer approval uses `submitted` (seller waiting on internal human) or `input-required` (buyer must respond).
- **`docs/building/integration/a2a-response-format.mdx`** — "Media Buy with Approval Required" example no longer puts an invalid `status: "pending_approval"` on package objects (Package has no `status` field); replaced with `total_budget` / `currency`.

Closes #2270, closes #2351.
