-- Add slack_thread_ts to brand_logos so the approve/reject path can thread
-- the resolution reply under the original "Logo pending review" Slack
-- notification (#4754). Without this, moderators see "approved" / "rejected"
-- announcements floating in the channel with no connection to the upload
-- they're resolving.
--
-- TEXT type matches Slack's message-ts format (e.g. "1779110411.874"). NULL
-- when the upload predates the notification path or when Slack wasn't
-- configured at upload time — the reply path treats NULL as "skip thread".

ALTER TABLE brand_logos
  ADD COLUMN IF NOT EXISTS slack_thread_ts TEXT;
