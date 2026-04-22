---
---

Fix Addie's editorial submission path (epic #2693): bundle of five related fixes so a member sharing a draft via Addie reliably lands in `pending_review`, reviewers can actually work the queue from Slack, and no caller silently bypasses editorial review.

- **#2696 — Review bypass eliminated.** `proposeContentForUser` no longer defaults to `published` for leads/admins; explicit `status: 'published'` is required to publish. Share-a-Link, newsletter send-pipeline, and digest-publisher now pass `status: 'published'` explicitly. Addie's `propose_content` passes `status: 'pending_review'` as defense in depth.
- **#2694 — Addie Slack tools can authenticate.** `list_pending_content`, `approve_content`, `reject_content` now call newly-extracted `listPendingContentForUser` / `approveContentForUser` / `rejectContentForUser` directly, bypassing HTTP auth (same pattern as `propose_content`). The `/api/content/pending`, `/:id/approve`, `/:id/reject` HTTP handlers also route through these functions so logic lives in one place.
- **#2695 — Content tools always reachable.** `propose_content`, `get_my_content`, `list_pending_content`, `approve_content`, `reject_content` added to `ALWAYS_AVAILABLE_TOOLS`. Submitting / reviewing a perspective no longer depends on the Haiku router picking the `member` / `content` set.
- **#2697 — No more "image required" hallucination.** `propose_content` tool description now states cover images are optional and can be added post-publish. System prompt adds an anti-hallucination rule: don't speculate about required fields; attempt the action and surface real errors.
- **#2698 — Escalation is fallback, not default.** System prompt now directs Addie to call `propose_content` when a member shares a draft, rather than filing an escalation as a first response.
