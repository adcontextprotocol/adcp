---
---

**Admin UI for editorial + announcement channels; Stage 1 env-var → DB migration**

Closes two follow-ups flagged during Workflow B Stage 2/3 reviews.

**Admin UI (`admin-settings.html`).** Two new sections on the System
Settings page:

- *Editorial review channel* — private-channel picker. Stores into the
  existing `editorial_slack_channel` setting. Workflow B Stage 1 review
  cards land here.
- *Public announcement channel* — public-channel picker (pulls from the
  `?visibility=public` variant of the picker endpoint). Stores into
  the `announcement_slack_channel` setting added in Stage 2.

Previously both settings were DB-backed but API-only — editorial team
had to `curl PUT /api/admin/settings/editorial-channel` to configure.

**Stage 1 reader migration.** `runAnnouncementTriggerJob` and the
backfill script now call a new `resolveEditorialChannel()` that prefers
the DB setting and falls back to the legacy
`SLACK_EDITORIAL_REVIEW_CHANNEL` env var. Safe rollout: existing prod
config keeps working on deploy; once the admin UI is in prod an
operator can set the DB value and we can drop the env var in a later
PR.

Also: transient DB read failures fall back to env rather than blocking
the job — the job cares about *any* way of getting a channel id, not
whichever storage won the coin flip this hour.

**Tests.** `tests/announcement/announcement-channel-resolver.test.ts`
— 8 tests covering DB-populated wins over env, env-fallback-on-null,
both-null → null, env whitespace/empty handling, DB-throws → env
fallback, DB-throws + env-unset → null.

Full announcement suite 143/143 pass; typecheck clean.
