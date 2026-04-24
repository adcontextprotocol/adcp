---
---

**Workflow B: stale-LinkedIn reminders**

Closes the Workflow B loop. The backlog view (#3014) already flags
stuck rows with a red badge, but editorial has to open the page to
see it. This job posts a threaded reply on the *original* review
card — the same thread they'd act on — when LinkedIn has been
pending for more than 7 days.

**Behavior.** Daily job scans for orgs where:

- Slack was posted more than 7 days ago
- LinkedIn is not yet marked
- Draft was not skipped
- No reminder has been sent in the last 7 days
- Fewer than 3 reminders have ever been sent for this draft

Posts as a **threaded reply** to the review card (preserves context;
the Mark-LI button is right there), and records an
`announcement_li_reminder_sent` activity for the rate-limit. Max 3
reminders per org so a permanently-stuck draft doesn't generate
reminders forever.

**New:**

- `findStaleLiCandidates()` / `runAnnouncementReminderJob()` in
  `announcement-trigger.ts`.
- Constants `REMINDER_STALE_DAYS` (7), `REMINDER_INTERVAL_DAYS` (7),
  `MAX_REMINDERS_PER_ORG` (3).
- Registered in `job-definitions.ts` as `announcement-li-reminder` —
  24 h interval, 10–11 am business hours, skip weekends so reminders
  land when editorial is actually online.

**Tests.** 11 new tests in `announcement-reminder.test.ts`:

- SQL params (rate-limit values pinned)
- SQL exclusion clauses (`li_posts IS NULL`, `skipped IS NULL`, cap)
- Orphan-org fallback + integer coercion on `days_since_slack`
- Happy path: threaded reply + activity write
- Reminder-number increments across runs (reminder_count + 1)
- Slack post failure: no activity row written, failed++
- Activity-write failure after successful post: counts as reminded,
  but logs; next run may re-ping (accepted edge case — unwinding a
  thread reply is worse UX than an extra ping)
- Per-candidate failure doesn't stop the batch
- Candidate-load failure returns zeros, doesn't throw
- Empty candidate list short-circuits cleanly
- `buildReminderText` renders all fields in Slack mrkdwn + linkifies
  the admin backlog URL

Full announcement suite 167/167 pass; server typecheck clean.

**Ops.** First scheduled run lands 22 minutes after server start,
then daily at 10 am local. `shouldLogResult` only logs when
`reminded > 0 || failed > 0` so quiet days stay quiet.
