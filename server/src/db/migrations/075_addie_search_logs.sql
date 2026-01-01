-- =====================================================
-- SEARCH TRACKING FOR ADDIE
-- =====================================================
-- Logs all search queries and results for:
-- 1. Pattern analysis (what do users search for?)
-- 2. Gap detection (queries with zero/low results)
-- 3. Quality monitoring (are searches returning useful results?)

CREATE TABLE IF NOT EXISTS addie_search_logs (
  id SERIAL PRIMARY KEY,

  -- Query details
  query TEXT NOT NULL,
  tool_name VARCHAR(100) NOT NULL,  -- 'search_docs', 'search_repos', etc.

  -- Search parameters
  category VARCHAR(100),
  limit_requested INTEGER,

  -- Results
  results_count INTEGER NOT NULL,
  result_ids TEXT[],              -- Array of matched doc/heading IDs
  top_result_score FLOAT,

  -- Context
  thread_id UUID,                 -- Which thread triggered this search (nullable for API calls)
  channel VARCHAR(50),            -- 'slack', 'web', 'api', etc.

  -- Timing
  search_latency_ms INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for analyzing search patterns over time
CREATE INDEX IF NOT EXISTS idx_addie_search_logs_created
  ON addie_search_logs(created_at DESC);

-- Index for finding zero-result queries
CREATE INDEX IF NOT EXISTS idx_addie_search_logs_zero_results
  ON addie_search_logs(results_count)
  WHERE results_count = 0;

-- Index for pattern analysis by tool
CREATE INDEX IF NOT EXISTS idx_addie_search_logs_tool
  ON addie_search_logs(tool_name, created_at DESC);

-- View for analyzing search patterns
CREATE OR REPLACE VIEW addie_search_analytics AS
SELECT
  DATE_TRUNC('day', created_at) as date,
  tool_name,
  COUNT(*) as total_searches,
  COUNT(*) FILTER (WHERE results_count = 0) as zero_result_searches,
  ROUND(AVG(results_count), 1) as avg_results,
  ROUND(AVG(search_latency_ms), 0) as avg_latency_ms
FROM addie_search_logs
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', created_at), tool_name
ORDER BY date DESC, tool_name;

COMMENT ON TABLE addie_search_logs IS 'Tracks all Addie search queries for pattern analysis and gap detection';
