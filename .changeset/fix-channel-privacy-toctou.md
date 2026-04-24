---
---

Close #2735: recheck Slack channel privacy at send time before posting sensitive content.

The admin-settings routes (`billing-channel`, `escalation-channel`, `admin-channel`, `prospect-channel`, `error-channel`, `editorial-channel`) validate `is_private === true` at write time, but Slack lets a channel owner flip the channel public afterward — and the server wouldn't notice. Billing events, escalation summaries, editorial reviewer names, admin alerts, prospect data, and system errors could all leak into a formerly-private channel that's now workspace-visible.

- New `verifyChannelStillPrivate(channelId)` helper in `server/src/slack/client.ts` — uses the existing 30-minute channel-info cache so the happy path is free, returns `false` when the channel is no longer private (or can't be verified), emits a structured `channel_privacy_drift` warn log.
- `sendChannelMessage` gained an `options.requirePrivate` flag. When `true`, the gate blocks the send and returns `{ ok: false, skipped: 'not_private' }`. Default is `false` — WG / announcement channels aren't regressed.
- All six sensitive notification flows now opt in: billing, prospect (two handlers), assessment (admin channel), error-notifier (two paths), escalation tool, editorial pending-content notification.
- Drive-by: fixed a pre-existing main typecheck break in `training-agent/task-handlers.ts` (stale `asset_type` discriminator after #2795).

Daily audit job for channels that aren't written to often is tracked separately as #2849.
