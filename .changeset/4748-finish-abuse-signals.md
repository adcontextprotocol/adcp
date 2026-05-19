---
---

feat(brand-logos): finish #4748 — abuse signals, reserved owner slots, threaded Slack replies

Closes the remaining wedges from #4748 after #4754 (Slack notify) and #4755 (queue UI).

**A. Per-user pending-queue threshold.** A community uploader who already has 5 pending uploads across distinct domains in the last hour gets 429 on the next attempt (`code: 'pending_queue_full'`). Defends against the enumeration vector flagged in #4743's security review (fan out pending uploads to probe ownership state) and against queue saturation. Verified owners bypass the check entirely — they're attesting their own brand, not enumerating. Soft-pause: just rejects new attempts; existing pending stays and the threshold relaxes as moderators clear them. Same threshold applied to Addie's `upload_brand_logo` tool (counted as `system:addie`).

**B. Per-brand reserved owner slots.** `MAX_LOGOS_PER_BRAND` is 10 total. Community uploads (any status, `source='community'`) are now capped at 5 of those slots so a verified owner who claims later always has room for their own logos even if community-pending got there first. Owner uploads still respect the overall cap; only the per-source cap is new. Returns `code: 'community_cap_reached'` when tripped.

**C. Threaded approve/reject Slack replies.** Migration 484 adds `slack_thread_ts TEXT` to `brand_logos`. The HTTP route and Addie tool now persist the ts returned by `notifyPendingBrandLogo` on the row. The review endpoint loads that ts before mutation and threads a verdict reply (`notifyBrandLogoReviewed`) under the original announcement. Channel reads as a conversation instead of disconnected verdicts. Silently skips when the row predates this PR or Slack isn't configured.

**Tests**

10 new tests in `brand-logos-abuse-signals.test.ts` cover the threshold (trip, bypass for owner, pass-under), the per-source cap (community cap, owner overall-cap, owner bypass of community cap), and threading (persist on success, skip on null, thread verdict, skip when no stored ts). All 38 logo-related unit tests still pass together. TypeScript clean.

**Closes #4748.**
