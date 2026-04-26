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

**Hardening (expert-review follow-ups).**

- Hard ceiling: `--limit` defaults to 15, soft-caps at 50 without
  `--force`, absolute-capped at 200 with `--force`. Prevents a fat-
  fingered `--limit 9999` from flooding the editorial channel or
  billing thousands of Anthropic tokens.
- `pg_try_advisory_lock` at run start — two operators (or a duplicate
  invocation) running backfill simultaneously would otherwise race the
  `NOT EXISTS` idempotency filter. The second caller now refuses with
  `lockedOut:true` instead of producing duplicate posts.
- Dry-run preview rows now include `membership_tier`,
  `primary_brand_domain`, and `last_published_at` so the operator can
  decide from the dry-run output whether the list looks right.
- Live run prints the succeeded-orgs list to stdout and posts a single
  summary message (`📦 Backfill wave posted — N retroactive drafts…`)
  to the editorial channel so editorial gets a nudge without watching
  the CLI.
- Ops pre-flight ritual documented in the script header: dry-run
  first, start with `--limit 3`, Ctrl-C is safe, only one run at a
  time, hard ceilings explained.

14 new tests on top of the original 21 (32 total) cover the hardening:
force toggle, soft-cap enforcement, absolute-max ceiling, advisory
lock lockout path, summary message on drafted>0 and skip when 0,
drafted_orgs shape, rich-fixture drafter call-through, and the two
unwind-failure branches. Full announcement suite 135/135 pass.
