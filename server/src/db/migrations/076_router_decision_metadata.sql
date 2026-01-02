-- =====================================================
-- ROUTER DECISION METADATA FOR ADDIE MESSAGES
-- =====================================================
-- Adds router decision tracking to unified thread messages.
-- When Addie uses the Haiku router to decide whether/how to respond
-- to channel messages, this metadata captures the decision details.

-- Add router_decision column to messages
ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS router_decision JSONB;

-- The router_decision JSONB structure:
-- {
--   "action": "respond" | "ignore" | "react" | "clarify",
--   "reason": "Brief explanation of the decision",
--   "decision_method": "quick_match" | "llm",
--   "tools": ["search_docs", "validate_adagents"],  -- only for "respond" action
--   "latency_ms": 150,
--   "tokens_input": 500,       -- only for LLM decisions
--   "tokens_output": 50,       -- only for LLM decisions
--   "model": "claude-haiku-4-5"  -- only for LLM decisions
-- }

-- Index for analyzing router decisions
CREATE INDEX IF NOT EXISTS idx_addie_messages_router_action
  ON addie_thread_messages ((router_decision->>'action'))
  WHERE router_decision IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_addie_messages_router_method
  ON addie_thread_messages ((router_decision->>'decision_method'))
  WHERE router_decision IS NOT NULL;

-- Drop both views explicitly to avoid column ordering issues
DROP VIEW IF EXISTS addie_feedback_summary;
DROP VIEW IF EXISTS addie_execution_analysis;

-- Recreate execution analysis view with router metrics
CREATE VIEW addie_execution_analysis AS
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
  t.active_rules_snapshot,
  -- Router decision fields
  m.router_decision->>'action' as router_action,
  m.router_decision->>'reason' as router_reason,
  m.router_decision->>'decision_method' as router_decision_method,
  (m.router_decision->>'latency_ms')::integer as router_latency_ms,
  (m.router_decision->>'tokens_input')::integer as router_tokens_input,
  (m.router_decision->>'tokens_output')::integer as router_tokens_output,
  m.router_decision->>'model' as router_model,
  m.router_decision->'tools' as router_tools
FROM addie_thread_messages m
JOIN addie_threads t ON m.thread_id = t.thread_id
WHERE m.role = 'assistant';

-- Recreate the feedback summary view with router metrics
CREATE VIEW addie_feedback_summary AS
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
  -- Router metrics
  COUNT(*) FILTER (WHERE m.router_decision IS NOT NULL) as routed_count,
  ROUND(AVG((m.router_decision->>'latency_ms')::numeric) FILTER (WHERE m.router_decision IS NOT NULL), 0) as avg_router_latency_ms,
  -- Aggregate feedback tags
  ARRAY_AGG(DISTINCT tag) FILTER (WHERE tag IS NOT NULL) as all_tags
FROM addie_thread_messages m
JOIN addie_threads t ON m.thread_id = t.thread_id
LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(m.feedback_tags, '[]'::jsonb)) as tag ON true
WHERE m.role = 'assistant'
  AND m.created_at > NOW() - INTERVAL '90 days'
GROUP BY DATE_TRUNC('day', m.created_at), t.channel
ORDER BY date DESC, channel;

COMMENT ON COLUMN addie_thread_messages.router_decision IS 'Haiku router decision metadata: action, reason, method, latency, tokens';
