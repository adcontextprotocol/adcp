-- Migration: 246_soft_delete_threads.sql
-- Add a flag to track when the originating Slack message has been deleted.
-- Threads remain fully visible in admin for auditing.

ALTER TABLE addie_threads
  ADD COLUMN IF NOT EXISTS slack_deleted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_addie_threads_slack_deleted ON addie_threads(slack_deleted)
  WHERE slack_deleted = TRUE;

COMMENT ON COLUMN addie_threads.slack_deleted IS
  'True when the originating Slack message was deleted. Thread remains visible in admin for auditing.';

-- Rebuild the summary view to include slack_deleted
DROP VIEW IF EXISTS addie_threads_summary;
CREATE VIEW addie_threads_summary AS
SELECT
  t.thread_id,
  t.channel,
  t.external_id,
  t.user_type,
  t.user_id,
  t.user_display_name,
  t.title,
  t.message_count,
  t.flagged,
  t.reviewed,
  t.slack_deleted,
  t.started_at,
  t.last_message_at,
  -- Slack channel name extracted from context JSONB (stored as channel_name on new threads)
  t.context->>'channel_name' as slack_channel_name,
  -- First user message as preview
  (SELECT content FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND role = 'user'
   ORDER BY sequence_number LIMIT 1) as first_user_message,
  -- Last assistant message as preview
  (SELECT content FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND role = 'assistant'
   ORDER BY sequence_number DESC LIMIT 1) as last_assistant_message,
  -- Average rating
  (SELECT ROUND(AVG(rating)::numeric, 2) FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND rating IS NOT NULL) as avg_rating,
  -- Total latency
  (SELECT SUM(latency_ms) FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND latency_ms IS NOT NULL) as total_latency_ms,
  -- Feedback indicators
  (SELECT COUNT(*) FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND rating IS NOT NULL)::int as feedback_count,
  (SELECT COUNT(*) FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND rating IS NOT NULL AND rating_source = 'user')::int as user_feedback_count,
  (SELECT COUNT(*) FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND rating IS NOT NULL AND rating >= 4)::int as positive_feedback_count,
  (SELECT COUNT(*) FROM addie_thread_messages
   WHERE thread_id = t.thread_id AND rating IS NOT NULL AND rating <= 2)::int as negative_feedback_count
FROM addie_threads t;
