---
---

**Workflow B Stage 2 — announcement review button handlers**

Wires the three review-card buttons posted by Stage 1 to action handlers:

- `Approve & Post to Slack` publishes the approved draft + visual to the
  configured public announcement channel, records an
  `announcement_published` activity row (channel=slack), and re-renders
  the review card to show Slack done + LinkedIn pending.
- `Mark posted to LinkedIn` records `announcement_published`
  (channel=linkedin) for the external post; re-renders the card to
  show both channels done.
- `Skip` records `announcement_skipped` and removes the action buttons.

**State-driven rendering.** Each handler loads the current state from
`org_activities` and re-renders the card from scratch on every click.
Re-clicks, lost acks, and out-of-order events converge to the same
result instead of drifting.

**Idempotency + unwind.** `approve_slack` uses Stage 1's post-then-record
ordering: if the activity write fails after a successful public post,
`chat.delete` unwinds the message so the next retry re-publishes cleanly
instead of leaving an orphan announcement with no idempotency row. An
existing `announcement_published` row short-circuits further posts.

**Admin gate.** Every action is gated on `isSlackUserAAOAdmin`. Non-admins
get an ephemeral rejection.

**New config.** Adds `announcement_slack_channel` to `system_settings`
with `PUT /api/admin/settings/announcement-channel`. Unlike the other
channel settings this one requires a *public* channel — a private one
would defeat the point of a broad welcome. The `/slack-channels` picker
accepts `?visibility=public` for public-channel pickers.

**Hardening (second-round review).**
- Each state-changing handler now runs inside a transaction holding a
  Postgres advisory lock keyed on `(orgId, action)`. Two rapid clicks
  (admin double-click, or Slack's 3s-no-ack retry) serialize — the
  second caller observes the row written by the first and falls
  through the idempotent "already done" branch instead of producing a
  duplicate public post.
- `buildPublicAnnouncementPayload` re-validates `visual_url` through
  `isSafeVisualUrl` before forwarding to the public channel. Stage 1
  validated at write time; a row inserted through a non-drafter path
  (manual SQL, future admin tool, migration) can no longer flow an
  attacker-chosen URL into Slack.
- Public-post text runs through a URL scrubber that replaces bare
  `https://…` URLs not on AAO's host with `[link removed]`. The
  drafter prompt forbids non-profile URLs, but adversarial
  brand.json/tagline input could still leak a link through the model;
  this is the last-mile defense.
- `extractActionContext` now validates `channelId` against
  `^[CGD][A-Z0-9]+$` and `messageTs` against `^\d+\.\d+$`, matching
  the pattern `settings.ts` already uses on admin channel-id writes.
- `ORG_ID_PATTERN` tightened to case-sensitive (WorkOS org IDs are
  fixed-case uppercase).
- Action IDs centralized in `ANNOUNCE_ACTION_IDS` constant.

**Known follow-ups (not in this PR).**
- Admin UI surface for both `editorial_channel` and `announcement_channel`
  — neither is exposed in `admin-settings.html` yet.
- Stage 1's review channel still reads from `SLACK_EDITORIAL_REVIEW_CHANNEL`
  env; migrating it to `getEditorialChannel()` is a separate cleanup.
- Manual smoke test in a live Slack workspace (button click flow) still
  recommended before this lands in production.
