---
---

fix(editorial): security hardening bundle — rate limit, status transitions, WG post invariant.

Three epic #2693 follow-ups surfaced by expert review, all small but closing real holes:

**#2733 — Rate limit POST /api/content/propose.** New `contentProposeRateLimiter` (20 per 10 min per user, Postgres-backed store like the other rate limiters). Protects the editorial queue from accidental floods and scripted abuse that would burn Slack API quota and Gemini cover-image credits on the downstream async work. Legitimate editorial cadence is well below the threshold.

**#2713 — Lock down rejected/archived status transitions.** `PUT /api/me/content/:id` previously allowed any non-admin with `isProposer || isAuthor || userIsLead` permission to flip `rejected` → `pending_review`. That meant a co-author on an unrelated committee could resurrect a rejected item without going through the rejecter. Now: moving out of `rejected` or `archived` requires admin OR the lead of the item's own committee. `draft ↔ pending_review` transitions are unchanged.

**#2712 — Document + enforce the WG-posts / editorial distinction.** `POST /api/working-groups/:slug/posts` is intentionally NOT the editorial review path — it's for working-group-internal discussion, members-only by default. Added a comment block explaining the invariant, and tightened the endpoint: non-leaders who pass `is_members_only: false` now get a 403 with a clear message pointing them to the Perspectives flow. Previously that field was silently coerced to `true`.

Integration tests cover the rejected-resurrection blocks (non-lead co-author → 403, committee lead → 200). Title-length validation tests from the prior bundle still cover the propose path.

Two related follow-ups NOT in this bundle — bigger scope:
- #2735 channel privacy TOCTOU recheck (applies across six sibling channels, needs caching design)
- #2755 rate limit web Addie tool calls (needs a per-user wrapper around `createUserScopedTools`)
