-- Per-message speaker identity for unified threads.
--
-- addie_threads has a single user_id (the thread starter), but Slack channel
-- threads have multiple human speakers. Without per-message speaker info,
-- conversation history sent back to the LLM collapses every speaker into
-- "User", so Addie can't tell when a different person joins the thread —
-- e.g. an admin replying mid-thread to a non-member's question.
--
-- These columns are populated for slack/web/email/admin user-role messages.
-- Older rows stay NULL; readers must fall back to the thread's user_id.

ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS user_display_name VARCHAR(255);

COMMENT ON COLUMN addie_thread_messages.user_id IS
  'External speaker id for this message (Slack user id, WorkOS user id, or NULL for non-user roles / legacy rows). For multi-speaker threads readers must use this, not addie_threads.user_id.';

COMMENT ON COLUMN addie_thread_messages.user_display_name IS
  'Resolved display name of the speaker at the time the message was logged. Used to label conversation history sent to the LLM.';
