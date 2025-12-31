-- =====================================================
-- ENHANCED EXECUTION METADATA FOR ADDIE MESSAGES
-- =====================================================
-- Adds detailed timing breakdown and execution context for evaluation

-- Add timing breakdown to messages
ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS timing_system_prompt_ms INTEGER,
  ADD COLUMN IF NOT EXISTS timing_total_llm_ms INTEGER,
  ADD COLUMN IF NOT EXISTS timing_total_tool_ms INTEGER,
  ADD COLUMN IF NOT EXISTS processing_iterations INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_cache_creation INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_cache_read INTEGER,
  ADD COLUMN IF NOT EXISTS active_rule_ids INTEGER[];

-- Add full rules snapshot to threads (expanding the existing JSONB field)
-- The active_rules_snapshot field already exists but we'll document the expected structure:
-- {
--   "rule_ids": [1, 5, 23],
--   "rules": [
--     {"id": 1, "name": "Core Identity", "type": "system_prompt", "priority": 100, "content": "..."},
--     {"id": 5, "name": "Knowledge Search First", "type": "behavior", "priority": 90, "content": "..."}
--   ],
--   "captured_at": "2024-01-15T10:30:00Z"
-- }

-- Create index for analyzing messages by rule
CREATE INDEX IF NOT EXISTS idx_addie_messages_rule_ids ON addie_thread_messages USING GIN (active_rule_ids);

-- Create view for execution analysis
CREATE OR REPLACE VIEW addie_execution_analysis AS
SELECT
  m.message_id,
  m.thread_id,
  t.channel,
  m.created_at,
  m.role,
  m.latency_ms,
  m.timing_system_prompt_ms,
  m.timing_total_llm_ms,
  m.timing_total_tool_ms,
  m.processing_iterations,
  m.tokens_input,
  m.tokens_output,
  m.tokens_cache_creation,
  m.tokens_cache_read,
  m.tools_used,
  jsonb_array_length(COALESCE(m.tool_calls, '[]'::jsonb)) as tool_call_count,
  m.rating,
  m.rating_notes,
  m.feedback_tags,
  m.flagged,
  m.active_rule_ids,
  t.active_rules_snapshot
FROM addie_thread_messages m
JOIN addie_threads t ON m.thread_id = t.thread_id
WHERE m.role = 'assistant';

-- Create summary view for dashboard
CREATE OR REPLACE VIEW addie_feedback_summary AS
SELECT
  DATE_TRUNC('day', m.created_at) as date,
  t.channel,
  COUNT(*) as total_responses,
  COUNT(*) FILTER (WHERE m.rating IS NOT NULL) as rated_responses,
  ROUND(AVG(m.rating), 2) as avg_rating,
  COUNT(*) FILTER (WHERE m.rating >= 4) as positive_count,
  COUNT(*) FILTER (WHERE m.rating <= 2) as negative_count,
  ROUND(AVG(m.latency_ms), 0) as avg_latency_ms,
  ROUND(AVG(m.timing_total_llm_ms), 0) as avg_llm_ms,
  ROUND(AVG(m.timing_total_tool_ms), 0) as avg_tool_ms,
  COUNT(*) FILTER (WHERE m.flagged) as flagged_count,
  -- Aggregate feedback tags
  ARRAY_AGG(DISTINCT tag) FILTER (WHERE tag IS NOT NULL) as all_tags
FROM addie_thread_messages m
JOIN addie_threads t ON m.thread_id = t.thread_id
LEFT JOIN LATERAL unnest(m.feedback_tags) as tag ON true
WHERE m.role = 'assistant'
  AND m.created_at > NOW() - INTERVAL '90 days'
GROUP BY DATE_TRUNC('day', m.created_at), t.channel
ORDER BY date DESC, channel;

COMMENT ON VIEW addie_execution_analysis IS 'Detailed execution data per message for debugging and evaluation';
COMMENT ON VIEW addie_feedback_summary IS 'Daily aggregated feedback metrics for the evaluation dashboard';
