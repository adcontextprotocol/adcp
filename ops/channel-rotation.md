# Slack channel rotation — ops runbook

Quick reference for rotating a Slack channel wired into an admin
setting (billing / escalation / admin / prospect / error / editorial /
announcement). Written with the incident-response case in mind:
"something just happened, I need to reroute fast."

## Happy path (planned rotation)

1. Open `/admin/settings` in the admin portal.
2. Scroll to the relevant channel section (e.g. "Editorial review
   channel"). The current value is shown as `Current: #channel-name`.
3. If the new channel isn't in the dropdown: invite @Addie to it in
   Slack first, then reload `/admin/settings`. The picker only shows
   channels the bot is a member of — picks that wouldn't work at save
   time never appear.
4. Select the new channel, click **Save**. The admin UI writes the
   new value to `system_settings`, which is the sole source of truth
   for the active channel.
5. All setting writes go through `system_settings_audit` — the prior
   value, new value, and the WorkOS user who made the change are
   recorded. `getSettingAuditHistory(limit)` in
   `server/src/db/system-settings-db.ts` reads them back.

## Write-time failure modes

The `verifyChannelPrivacyForWrite` helper (`server/src/slack/client.ts`)
gates every setting write:

- **`cannot_verify`** — Slack returned nothing for the channel ID
  (bot not a member, Slack throttled, transient 5xx, wrong scope).
  The admin UI surfaces: *"Could not verify the channel for X. Invite
  @Addie to the channel in Slack and save again."* Fix is usually
  inviting the bot.
- **`wrong_privacy`** — the channel is the wrong kind (e.g. public
  channel picked for a private-required setting, or vice versa).
  Admin picks a different channel.

Both responses are 400s with distinct error strings. Neither writes
to the DB, so retrying is safe.

## Send-time safety net

For sensitive-content channels (billing / escalation / admin /
prospect / error / editorial), `sendChannelMessage(..., { requirePrivate: true })`
runs a fresh check at post time and refuses to post if the channel
drifted public between write and send. Editorial review drafts, Slack
review cards, and LI reminders all go through this gate.

## Incident scenario: review channel archived or gone

If the editorial review channel gets archived or the bot gets kicked,
Stage 1 (`runAnnouncementTriggerJob`) and the Stage 5 reminder job
will log a warning and skip. The LI reminder job has a dead-parent
path: if the original review card's thread can't be replied to, it
posts a fresh non-threaded notice to the same channel pointing at
`/admin/announcements`, then burns one of the three reminder slots so
it doesn't retry indefinitely.

**Recovery:**

1. Un-archive the channel in Slack, or pick a different private
   channel.
2. Re-invite @Addie.
3. Set the new value via `/admin/settings`. The admin UI is the only
   supported path — there is no env-var fallback anymore.

## DB-only rotation (break-glass)

If the admin UI is down but prod DB is reachable (say, Workos outage
taking out the session layer), a channel can be set directly via SQL.
This is break-glass only; normal ops should go through the UI so
audit + verification run.

```sql
Run this as one atomic CTE. It mirrors the shape of `setSetting()` in
`server/src/db/system-settings-db.ts` — capturing the *actual*
`old_value` (not hardcoded NULL) so post-incident review can see what
the channel was before the break-glass flip.

```sql
-- Replace keys as needed:
-- editorial_slack_channel, billing_slack_channel, escalation_slack_channel,
-- admin_slack_channel, prospect_slack_channel, error_slack_channel,
-- announcement_slack_channel.

WITH old AS (
  SELECT value AS old_value FROM system_settings
  WHERE key = 'editorial_slack_channel'
),
upserted AS (
  INSERT INTO system_settings (key, value, updated_at, updated_by)
  VALUES (
    'editorial_slack_channel',
    '{"channel_id":"C0NEWREVIEW","channel_name":"admin-editorial-review"}'::jsonb,
    NOW(),
    NULL  -- no WorkOS id available in break-glass mode
  )
  ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = NOW(),
      updated_by = NULL
  RETURNING value AS new_value
)
INSERT INTO system_settings_audit (key, old_value, new_value, changed_by, changed_at)
SELECT
  'editorial_slack_channel',
  old.old_value,
  upserted.new_value,
  'break-glass:runbook',
  NOW()
FROM upserted
LEFT JOIN old ON true;
```

Notes:

- `verifyChannelPrivacyForWrite` is skipped in this path. Confirm the
  channel is the right kind yourself before running.
- The send-time `requirePrivate` gate still fires on the next
  outbound post, so if you rotate to a public channel by mistake the
  job will refuse to post review content.
- File an incident note so the rotation can be reconciled with
  `/admin/settings` once the UI is back.

## Related

- `server/src/slack/client.ts` — `verifyChannelPrivacyForWrite`,
  `verifyChannelStillPrivate`, `sendChannelMessage`.
- `server/src/routes/admin/settings.ts` — write-side route handlers
  and the `requireChannelPrivacy` wrapper.
- `server/src/db/system-settings-db.ts` — `setSetting` atomically
  writes the value plus an audit row.
- `server/public/admin-settings.html` — admin UI.
- Issue #3003 — fail-closed write-time privacy check.
