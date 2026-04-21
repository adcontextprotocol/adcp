---
---

feat(editorial): reviewer notifications for content entering pending_review (#2701).

When a member submits content via the dashboard or Addie, reviewers now get a Slack notification they can action. Two notification paths run concurrently:

1. **Committee channel** (existing behavior, enriched): posts to the working group's configured `slack_channel_id` when set.
2. **Global editorial channel** (new): admins can configure a central `editorial_slack_channel` via `PUT /api/admin/settings/editorial-channel`, and pending-review content posts there too. Gives a reliable queue regardless of which committee the draft belongs to — previously, if the WG had no Slack channel, nobody was notified.

Notification content now includes:
- Excerpt (if supplied)
- Committee lead names (so reviewers know who owns the queue)
- Direct review link with the item id
- "Review" button

Security: user-supplied title/excerpt/author are run through a new `escapeSlackText` helper that escapes `<`, `>`, and `&` so a malicious submitter can't embed `<!here>`/`<!channel>`/`<@userid>` pings in a pending notification. Covered by `server/tests/unit/slack-escape.test.ts`.

Follow-ups still open on epic #2693:
- #2703 Google Docs reader
- #2700 auto cover image
- #2702 escalation linking
- #2699 rich-text paste
- Plus: stale-queue nudges (no issue yet — will file if it comes up)
