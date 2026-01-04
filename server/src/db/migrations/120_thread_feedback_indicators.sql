-- Migration: Add feedback indicator fields to addie_threads_summary view
-- This allows the admin UI to show at-a-glance feedback status for threads

CREATE OR REPLACE VIEW addie_threads_summary AS
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
  t.started_at,
  t.last_message_at,
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
