-- Separate the fixed-template notification headline from untrusted detail
-- (adcp#8320).
--
-- `notifications.title` is rendered as the first line of the Slack DM we
-- send to the recipient, and Slack parses that line as mrkdwn. Compliance
-- notifications were building the title by interpolating the stored
-- compliance `headline`, which for an unreachable agent is derived from the
-- agent's own error response — so a hostile or misbehaving agent could put
-- `<!channel>`, a forged link, or a 10 KB string into the title line of a
-- DM the owner reads as platform-authored.
--
-- The fix needs somewhere to put that detail, because dropping it entirely
-- would leave owners with a notification that says something is wrong but
-- not what. `body` is that place: a nullable, agent-/user-derived field that
-- every renderer treats as untrusted (escaped for mrkdwn on the Slack path,
-- HTML-escaped on the web path) and that no caller may promote into `title`.
--
-- Nothing backfills: existing rows keep their title-only shape and render
-- exactly as before.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body TEXT;

COMMENT ON COLUMN notifications.title IS
  'Fixed template plus sanitized platform-controlled fields. Never interpolate agent- or user-supplied free text here — use body.';
COMMENT ON COLUMN notifications.body IS
  'Optional untrusted detail (agent error text, run summaries). NotificationDatabase.createNotification flattens and truncates both title and body; every renderer escapes for its own surface.';
