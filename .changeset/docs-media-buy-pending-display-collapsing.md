---
---

docs(media-buy): document blessed pattern for collapsing `pending_creatives` and `pending_start` in buyer UIs.

Adds a `<Note>` block to the media-buy Lifecycle States section stating that buyer applications MAY render both pending states as a single `pending` label for display, but MUST preserve the raw status value on the wire (API responses, webhooks, persisted records, logs) so downstream gating keeps working. Reinforces the existing guidance to drive UI affordances from `valid_actions` rather than from the status value directly. Closes #2988. No schema change — docs guidance only.
