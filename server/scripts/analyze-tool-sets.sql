-- Analysis of Tool Sets Coverage
-- Run against production database to analyze how well tool sets would cover actual usage
--
-- Usage:
--   fly proxy 15432:5432 -a agentic-advertising-db
--   psql postgres://user:pass@localhost:15432/dbname -f scripts/analyze-tool-sets.sql

-- ============================================================================
-- TOOL SETS DEFINITION (must match tool-sets.ts)
-- ============================================================================

CREATE TEMP TABLE tool_sets (
  set_name TEXT PRIMARY KEY,
  tools TEXT[]
);

INSERT INTO tool_sets VALUES
  ('knowledge', ARRAY['search_docs', 'get_doc', 'search_repos', 'search_slack', 'get_channel_activity', 'search_resources', 'get_recent_news', 'fetch_url', 'read_slack_file']),
  ('member', ARRAY['get_my_profile', 'update_my_profile', 'list_working_groups', 'get_working_group', 'join_working_group', 'get_my_working_groups', 'express_council_interest', 'withdraw_council_interest', 'get_my_council_interests', 'list_perspectives', 'create_working_group_post', 'propose_content', 'get_my_content', 'bookmark_resource']),
  ('directory', ARRAY['search_members', 'request_introduction', 'get_my_search_analytics', 'list_members', 'get_member', 'list_agents', 'get_agent', 'list_publishers', 'lookup_domain']),
  ('agent_testing', ARRAY['validate_adagents', 'probe_adcp_agent', 'check_publisher_authorization', 'test_adcp_agent', 'validate_agent']),
  ('adcp_operations', ARRAY['get_products', 'create_media_buy', 'sync_creatives', 'list_creative_formats', 'list_authorized_properties', 'get_media_buy_delivery', 'build_creative', 'preview_creative', 'get_signals', 'activate_signal', 'call_adcp_agent', 'save_agent', 'list_saved_agents', 'remove_saved_agent', 'setup_test_agent']),
  ('content', ARRAY['draft_github_issue', 'propose_news_source', 'list_pending_content', 'approve_content', 'reject_content', 'add_committee_document', 'list_committee_documents', 'update_committee_document', 'delete_committee_document']),
  ('billing', ARRAY['find_membership_products', 'create_payment_link', 'send_invoice', 'send_payment_request', 'grant_discount', 'remove_discount', 'list_discounts', 'create_promotion_code']),
  ('meetings', ARRAY['schedule_meeting', 'check_availability']);

-- Always available tools
CREATE TEMP TABLE always_available (tool_name TEXT PRIMARY KEY);
INSERT INTO always_available VALUES
  ('escalate_to_admin'),
  ('get_account_link'),
  ('capture_learning'),
  ('web_search');

-- ============================================================================
-- ANALYSIS QUERIES
-- ============================================================================

\echo ''
\echo '============================================================================'
\echo 'TOOL USAGE ANALYSIS (Last 30 Days)'
\echo '============================================================================'
\echo ''

-- Overall tool usage frequency
\echo 'TOOL USAGE BY FREQUENCY:'
\echo '------------------------'
SELECT
  tool,
  COUNT(*) as usage_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as pct
FROM addie_thread_messages,
     LATERAL unnest(tools_used) as tool
WHERE role = 'assistant'
  AND created_at > NOW() - INTERVAL '30 days'
  AND tools_used IS NOT NULL
GROUP BY tool
ORDER BY usage_count DESC
LIMIT 25;

\echo ''
\echo 'TOOL SET MEMBERSHIP:'
\echo '--------------------'
-- Which set does each tool belong to?
SELECT
  tool,
  COUNT(*) as usage_count,
  COALESCE(
    (SELECT set_name FROM tool_sets WHERE tool = ANY(tools) LIMIT 1),
    CASE WHEN tool IN (SELECT tool_name FROM always_available) THEN 'ALWAYS_AVAILABLE' ELSE 'UNKNOWN' END
  ) as belongs_to_set
FROM addie_thread_messages,
     LATERAL unnest(tools_used) as tool
WHERE role = 'assistant'
  AND created_at > NOW() - INTERVAL '30 days'
  AND tools_used IS NOT NULL
GROUP BY tool
ORDER BY usage_count DESC
LIMIT 30;

\echo ''
\echo 'TOOL COMBINATIONS ANALYSIS:'
\echo '---------------------------'
-- What sets would cover each message's tool usage?
WITH tool_usage AS (
  SELECT
    message_id,
    tools_used,
    ARRAY(
      SELECT DISTINCT set_name
      FROM tool_sets
      WHERE tools_used && tools
    ) as sets_needed
  FROM addie_thread_messages
  WHERE role = 'assistant'
    AND created_at > NOW() - INTERVAL '30 days'
    AND tools_used IS NOT NULL
    AND array_length(tools_used, 1) > 0
)
SELECT
  array_length(sets_needed, 1) as num_sets_needed,
  sets_needed,
  COUNT(*) as message_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as pct
FROM tool_usage
GROUP BY sets_needed, array_length(sets_needed, 1)
ORDER BY message_count DESC
LIMIT 20;

\echo ''
\echo 'ROUTER ACCURACY (Old Tools vs Sonnet Actual):'
\echo '----------------------------------------------'
SELECT
  router_decision->'tools' as haiku_recommended,
  tools_used as sonnet_called,
  (router_decision->'tools')::jsonb = to_jsonb(tools_used) as exact_match,
  (SELECT array_agg(t) FROM unnest(tools_used) t
   WHERE NOT (router_decision->'tools') ? t) as extra_tools,
  (SELECT jsonb_agg(t) FROM jsonb_array_elements_text(router_decision->'tools') t
   WHERE NOT t = ANY(tools_used)) as unused_recommendations
FROM addie_thread_messages
WHERE router_decision IS NOT NULL
  AND tools_used IS NOT NULL
  AND created_at > NOW() - INTERVAL '30 days'
LIMIT 30;

\echo ''
\echo 'ROUTER MATCH RATE:'
\echo '------------------'
SELECT
  ROUND(
    COUNT(*) FILTER (WHERE (router_decision->'tools')::jsonb = to_jsonb(tools_used)) * 100.0 /
    NULLIF(COUNT(*), 0),
    1
  ) as exact_match_pct,
  ROUND(
    COUNT(*) FILTER (WHERE
      (SELECT COUNT(*) FROM unnest(tools_used) t WHERE NOT (router_decision->'tools') ? t) = 0
    ) * 100.0 /
    NULLIF(COUNT(*), 0),
    1
  ) as all_tools_recommended_pct,
  COUNT(*) as total_messages
FROM addie_thread_messages
WHERE router_decision IS NOT NULL
  AND tools_used IS NOT NULL
  AND created_at > NOW() - INTERVAL '30 days';

\echo ''
\echo 'HYPOTHETICAL: Tool Sets That Would Be Needed:'
\echo '----------------------------------------------'
-- For each message, show what tool sets would have covered the tools Sonnet used
WITH message_tools AS (
  SELECT
    message_id,
    tools_used,
    created_at
  FROM addie_thread_messages
  WHERE role = 'assistant'
    AND created_at > NOW() - INTERVAL '30 days'
    AND tools_used IS NOT NULL
    AND array_length(tools_used, 1) > 0
),
coverage AS (
  SELECT
    m.message_id,
    m.tools_used,
    ARRAY(
      SELECT DISTINCT set_name
      FROM tool_sets
      WHERE m.tools_used && tools
    ) as required_sets,
    ARRAY(
      SELECT t
      FROM unnest(m.tools_used) t
      WHERE NOT EXISTS (
        SELECT 1 FROM tool_sets WHERE t = ANY(tools)
      )
      AND NOT EXISTS (
        SELECT 1 FROM always_available WHERE t = tool_name
      )
    ) as uncovered_tools
  FROM message_tools m
)
SELECT
  required_sets,
  uncovered_tools,
  COUNT(*) as message_count
FROM coverage
GROUP BY required_sets, uncovered_tools
ORDER BY message_count DESC
LIMIT 20;

\echo ''
\echo 'UNCOVERED TOOLS (Tools Used But Not in Any Set):'
\echo '-------------------------------------------------'
SELECT
  tool,
  COUNT(*) as usage_count
FROM addie_thread_messages,
     LATERAL unnest(tools_used) as tool
WHERE role = 'assistant'
  AND created_at > NOW() - INTERVAL '30 days'
  AND tools_used IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tool_sets WHERE tool = ANY(tools)
  )
  AND NOT EXISTS (
    SELECT 1 FROM always_available WHERE tool = tool_name
  )
GROUP BY tool
ORDER BY usage_count DESC;

\echo ''
\echo 'ESTIMATED TOKEN SAVINGS:'
\echo '------------------------'
-- Assume ~100 tokens per tool definition
WITH total_tools AS (
  SELECT SUM(array_length(tools, 1)) as count FROM tool_sets
),
message_coverage AS (
  SELECT
    message_id,
    COALESCE(
      (SELECT SUM(array_length(tools, 1))
       FROM tool_sets
       WHERE tools_used && tools),
      0
    ) as tools_needed
  FROM addie_thread_messages
  WHERE role = 'assistant'
    AND created_at > NOW() - INTERVAL '30 days'
    AND tools_used IS NOT NULL
)
SELECT
  (SELECT count FROM total_tools) as total_tools_in_sets,
  ROUND(AVG(tools_needed), 1) as avg_tools_needed,
  ROUND(100 - (AVG(tools_needed) * 100.0 / (SELECT count FROM total_tools)), 1) as avg_token_savings_pct
FROM message_coverage;

DROP TABLE tool_sets;
DROP TABLE always_available;
