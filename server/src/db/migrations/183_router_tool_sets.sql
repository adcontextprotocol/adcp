-- =====================================================
-- ROUTER TOOL SETS
-- =====================================================
-- Updates router_decision schema from 'tools' (individual tool names)
-- to 'tool_sets' (category names like 'knowledge', 'member', etc.)
-- The view now reads both formats for backward compatibility.

-- Drop and recreate the execution analysis view
DROP VIEW IF EXISTS addie_execution_analysis;

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
  -- Support both old 'tools' and new 'tool_sets' formats
  COALESCE(m.router_decision->'tool_sets', m.router_decision->'tools') as router_tool_sets
FROM addie_thread_messages m
JOIN addie_threads t ON m.thread_id = t.thread_id
WHERE m.role = 'assistant';

COMMENT ON VIEW addie_execution_analysis IS 'Assistant response analysis including router decisions (tool_sets)';
