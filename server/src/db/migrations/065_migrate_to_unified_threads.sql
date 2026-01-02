-- Migration: 056_migrate_to_unified_threads.sql
-- Migrate existing data from separate tables to unified threads model
--
-- This migration:
-- 1. Migrates addie_conversations + addie_messages to addie_threads + addie_thread_messages
-- 2. Migrates addie_interactions to addie_threads + addie_thread_messages
-- 3. Preserves all existing data including feedback, ratings, etc.

-- =====================================================
-- 1. MIGRATE WEB CONVERSATIONS
-- =====================================================

-- Migrate conversations to threads
INSERT INTO addie_threads (
  thread_id,
  channel,
  external_id,
  user_type,
  user_id,
  user_display_name,
  context,
  message_count,
  impersonator_user_id,
  impersonation_reason,
  started_at,
  last_message_at,
  created_at,
  updated_at
)
SELECT
  conversation_id as thread_id,
  'web' as channel,
  conversation_id::text as external_id,
  CASE
    WHEN user_id IS NOT NULL THEN 'workos'
    ELSE 'anonymous'
  END as user_type,
  user_id,
  user_name as user_display_name,
  COALESCE(metadata, '{}') as context,
  message_count,
  impersonator_email as impersonator_user_id,
  impersonation_reason,
  started_at,
  last_message_at,
  created_at,
  created_at as updated_at
FROM addie_conversations
WHERE EXISTS (SELECT 1 FROM addie_conversations LIMIT 1)
ON CONFLICT (channel, external_id) DO NOTHING;

-- Migrate web messages
INSERT INTO addie_thread_messages (
  thread_id,
  role,
  content,
  tools_used,
  tool_calls,
  model,
  latency_ms,
  tokens_input,
  tokens_output,
  rating,
  rating_category,
  rating_notes,
  feedback_tags,
  improvement_suggestion,
  rated_by,
  rated_at,
  sequence_number,
  created_at
)
SELECT
  m.conversation_id as thread_id,
  m.role,
  m.content,
  CASE
    WHEN m.tool_use IS NOT NULL AND jsonb_array_length(m.tool_use) > 0
    THEN ARRAY(SELECT jsonb_array_elements_text(
      (SELECT jsonb_agg(t->>'name') FROM jsonb_array_elements(m.tool_use) AS t)
    ))
    ELSE NULL
  END as tools_used,
  m.tool_results as tool_calls,
  m.model,
  m.latency_ms,
  m.tokens_input,
  m.tokens_output,
  m.rating,
  m.rating_category,
  m.feedback_text as rating_notes,
  COALESCE(m.feedback_tags, '[]') as feedback_tags,
  m.improvement_suggestion,
  m.rated_by,
  m.rated_at,
  ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) as sequence_number,
  m.created_at
FROM addie_messages m
WHERE EXISTS (SELECT 1 FROM addie_messages LIMIT 1)
  AND EXISTS (
    SELECT 1 FROM addie_threads t
    WHERE t.thread_id = m.conversation_id
  )
ON CONFLICT DO NOTHING;

-- =====================================================
-- 2. MIGRATE SLACK INTERACTIONS
-- =====================================================

-- Slack interactions are stored as single rows with both input and output
-- We need to create threads and then split into user/assistant messages

-- First, create threads for unique channel:thread_ts combinations
INSERT INTO addie_threads (
  channel,
  external_id,
  user_type,
  user_id,
  context,
  flagged,
  flag_reason,
  reviewed,
  reviewed_by,
  reviewed_at,
  started_at,
  last_message_at,
  created_at,
  updated_at
)
SELECT DISTINCT ON (channel_id, thread_ts)
  'slack' as channel,
  CONCAT(channel_id, ':', thread_ts) as external_id,
  'slack' as user_type,
  user_id,
  jsonb_build_object(
    'event_type', event_type,
    'model', model
  ) as context,
  flagged,
  flag_reason,
  reviewed,
  reviewed_by,
  reviewed_at,
  created_at as started_at,
  created_at as last_message_at,
  created_at,
  created_at as updated_at
FROM addie_interactions
WHERE EXISTS (SELECT 1 FROM addie_interactions LIMIT 1)
  AND channel_id IS NOT NULL
  AND thread_ts IS NOT NULL
ORDER BY channel_id, thread_ts, created_at ASC
ON CONFLICT (channel, external_id) DO NOTHING;

-- Now create messages for each interaction
-- User message first
INSERT INTO addie_thread_messages (
  thread_id,
  role,
  content,
  content_sanitized,
  flagged,
  flag_reason,
  sequence_number,
  created_at
)
SELECT
  t.thread_id,
  'user' as role,
  i.input_text as content,
  i.input_sanitized as content_sanitized,
  i.flagged AND i.flag_reason LIKE '%input%' as flagged,
  CASE WHEN i.flag_reason LIKE '%input%' THEN i.flag_reason ELSE NULL END as flag_reason,
  (ROW_NUMBER() OVER (PARTITION BY t.thread_id ORDER BY i.created_at) - 1) * 2 + 1 as sequence_number,
  i.created_at
FROM addie_interactions i
JOIN addie_threads t ON t.external_id = CONCAT(i.channel_id, ':', i.thread_ts) AND t.channel = 'slack'
WHERE EXISTS (SELECT 1 FROM addie_interactions LIMIT 1)
  AND i.input_text IS NOT NULL
ON CONFLICT DO NOTHING;

-- Then assistant message
INSERT INTO addie_thread_messages (
  thread_id,
  role,
  content,
  tools_used,
  model,
  latency_ms,
  flagged,
  flag_reason,
  rating,
  rating_notes,
  outcome,
  user_sentiment,
  intent_category,
  rated_by,
  rated_at,
  sequence_number,
  created_at
)
SELECT
  t.thread_id,
  'assistant' as role,
  i.output_text as content,
  i.tools_used,
  i.model,
  i.latency_ms,
  i.flagged AND (i.flag_reason NOT LIKE '%input%' OR i.flag_reason IS NULL) as flagged,
  CASE WHEN i.flag_reason NOT LIKE '%input%' THEN i.flag_reason ELSE NULL END as flag_reason,
  i.rating,
  i.rating_notes,
  i.outcome,
  i.user_sentiment,
  i.intent_category,
  i.rating_by as rated_by,
  i.rated_at,
  (ROW_NUMBER() OVER (PARTITION BY t.thread_id ORDER BY i.created_at) - 1) * 2 + 2 as sequence_number,
  i.created_at + INTERVAL '1 millisecond' * COALESCE(i.latency_ms, 0) as created_at
FROM addie_interactions i
JOIN addie_threads t ON t.external_id = CONCAT(i.channel_id, ':', i.thread_ts) AND t.channel = 'slack'
WHERE EXISTS (SELECT 1 FROM addie_interactions LIMIT 1)
  AND i.output_text IS NOT NULL
ON CONFLICT DO NOTHING;

-- =====================================================
-- 3. UPDATE MESSAGE COUNTS
-- =====================================================

-- Update message_count for all migrated threads
UPDATE addie_threads t
SET message_count = (
  SELECT COUNT(*) FROM addie_thread_messages m WHERE m.thread_id = t.thread_id
)
WHERE message_count = 0
  AND EXISTS (SELECT 1 FROM addie_thread_messages m WHERE m.thread_id = t.thread_id);

-- =====================================================
-- 4. UPDATE last_message_at for threads
-- =====================================================

UPDATE addie_threads t
SET last_message_at = (
  SELECT MAX(created_at) FROM addie_thread_messages m WHERE m.thread_id = t.thread_id
)
WHERE EXISTS (SELECT 1 FROM addie_thread_messages m WHERE m.thread_id = t.thread_id);

-- =====================================================
-- 5. COMMENTS
-- =====================================================

COMMENT ON TABLE addie_threads IS 'Unified conversation threads with Addie across all channels - includes migrated data from addie_conversations and addie_interactions';
COMMENT ON TABLE addie_thread_messages IS 'Individual messages within Addie conversation threads - includes migrated data from addie_messages';

-- =====================================================
-- 6. LOG MIGRATION STATS
-- =====================================================
-- (This just creates a DO block to log stats - can be removed after migration)

DO $$
DECLARE
  threads_from_conversations INTEGER;
  threads_from_interactions INTEGER;
  messages_from_web INTEGER;
  messages_from_slack INTEGER;
BEGIN
  SELECT COUNT(*) INTO threads_from_conversations FROM addie_threads WHERE channel = 'web';
  SELECT COUNT(*) INTO threads_from_interactions FROM addie_threads WHERE channel = 'slack';
  SELECT COUNT(*) INTO messages_from_web FROM addie_thread_messages m
    JOIN addie_threads t ON m.thread_id = t.thread_id WHERE t.channel = 'web';
  SELECT COUNT(*) INTO messages_from_slack FROM addie_thread_messages m
    JOIN addie_threads t ON m.thread_id = t.thread_id WHERE t.channel = 'slack';

  RAISE NOTICE 'Migration complete:';
  RAISE NOTICE '  Web threads: %', threads_from_conversations;
  RAISE NOTICE '  Slack threads: %', threads_from_interactions;
  RAISE NOTICE '  Web messages: %', messages_from_web;
  RAISE NOTICE '  Slack messages: %', messages_from_slack;
END $$;
