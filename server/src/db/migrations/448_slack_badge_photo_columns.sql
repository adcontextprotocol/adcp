-- Photo-overlay badge infrastructure for @aao-members Slack profile photos.
--
-- original_photo_url: saves the user's pre-badge photo URL so we can revert
--   on membership.deleted or per-user opt-out.
-- badge_photo_applied_at: timestamp of last successful badge apply; used by
--   the daily reconcile job to detect stale badges (user changed their own
--   photo since last apply).
-- badge_opt_out: per-user opt-out flag for photo badge application.
-- badge_applied_photo_url: Slack CDN URL of the composited badge photo after
--   upload. The daily reconcile compares the user's current profile URL against
--   this value to detect whether they have changed their own photo since the
--   badge was last applied.

ALTER TABLE slack_user_mappings
  ADD COLUMN IF NOT EXISTS original_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS badge_photo_applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS badge_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS badge_applied_photo_url TEXT;
