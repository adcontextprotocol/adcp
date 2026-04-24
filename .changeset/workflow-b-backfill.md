---
---

**Workflow B Stage 4 — retroactive announcement backfill**

One-shot script that posts retroactive new-member announcement drafts
to the editorial review channel so orgs who became announce-ready
before Workflow A's `profile_published` event emit don't get left out
of the welcome flow.

Spec: `specs/new-member-announcements.md` → "Backfill".

**New:**

- `server/src/scripts/backfill-member-announcements.ts` — CLI entry
  point. `--limit N` (default 15) caps the run so a single invocation
  can't flood the editorial channel. `--dry-run` reports eligible
  candidates without posting or writing activity rows.
- `runBackfillAnnouncements({ reviewChannel, limit, dryRun })` in
  `announcement-trigger.ts` — drives the per-candidate pipeline with
  the `backfill: true` flag so review cards get a `[BACKFILL]` header
  prefix.

**Refactors:**

- `findAnnounceCandidates({ requireProfilePublished })` — backfill drops
  the `profile_published` EXISTS clause (those orgs predate the event).
- Extracted `processAnnounceCandidate` — shared by the live trigger
  and the backfill, keeps the post-then-record unwind semantics.
- `buildReviewBlocks({ backfill })` — header prefix only.
- Recorded `announcement_draft_posted` metadata gains `backfill: true`
  so downstream analytics can tell retroactive drafts apart.

**Safety:**

- Idempotency via the existing `NOT EXISTS` on `announcement_draft_posted`
  / `announcement_skipped` — re-running the script will not re-post
  orgs that landed on a previous run.
- Dry-run produces no Slack traffic and no DB writes.
- Unwind (chat.delete) on activity-write failure, same as the live job.

**Tests:** 19 new tests in `tests/announcement/announcement-backfill.test.ts`
covering SQL shape (profile_published clause presence), header tag
behavior, limit enforcement (default 15 + override), `backfill:true`
metadata, candidate-load failure recovery, per-candidate failure
isolation, and CLI arg parsing. Full announcement suite 122/122 pass.

**Ops.** Operator picks the right moment, runs
`npx tsx server/src/scripts/backfill-member-announcements.ts --limit 10`
with SLACK_EDITORIAL_REVIEW_CHANNEL + ADDIE_BOT_TOKEN + ANTHROPIC_API_KEY
set. Editorial team approves through the existing Stage 2 Slack buttons.
