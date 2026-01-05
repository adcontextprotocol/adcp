-- Migration: 079_agent_contexts.sql
-- Agent Testing Context System
--
-- Stores agent URLs that users are working on, their test history,
-- and securely stored auth tokens (encrypted).

-- =====================================================
-- AGENT CONTEXTS TABLE
-- =====================================================
-- Tracks agents that organizations are developing/testing

CREATE TABLE IF NOT EXISTS agent_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Organization scope
  organization_id TEXT NOT NULL REFERENCES organizations(workos_organization_id),

  -- Agent identification
  agent_url TEXT NOT NULL,                    -- The agent's MCP/A2A endpoint
  agent_name TEXT,                            -- Friendly name like "Our Production Sales Agent"
  agent_type TEXT DEFAULT 'unknown'           -- 'sales' | 'creative' | 'signals' | 'unknown'
    CHECK (agent_type IN ('sales', 'creative', 'signals', 'unknown')),
  protocol TEXT DEFAULT 'mcp'                 -- 'mcp' | 'a2a'
    CHECK (protocol IN ('mcp', 'a2a')),

  -- Secure token storage
  -- Token is encrypted with AES-256-GCM using org-specific derived key
  -- NEVER expose the actual token in responses or logs
  auth_token_encrypted TEXT,                  -- Encrypted token (base64)
  auth_token_iv TEXT,                         -- Initialization vector (base64)
  auth_token_hint TEXT,                       -- Last 4 chars for display: "****ABCD"

  -- Discovery cache (updated after each test)
  tools_discovered TEXT[],                    -- ['get_products', 'create_media_buy', ...]
  last_discovered_at TIMESTAMPTZ,

  -- Test history
  last_test_scenario TEXT,                    -- Most recent scenario run
  last_test_passed BOOLEAN,                   -- Did it pass?
  last_test_summary TEXT,                     -- Brief summary
  last_tested_at TIMESTAMPTZ,
  total_tests_run INTEGER DEFAULT 0,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT,                            -- WorkOS user ID who added it

  -- One agent URL per organization
  UNIQUE(organization_id, agent_url)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_contexts_org ON agent_contexts(organization_id);
CREATE INDEX IF NOT EXISTS idx_agent_contexts_type ON agent_contexts(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_contexts_updated ON agent_contexts(updated_at DESC);

COMMENT ON TABLE agent_contexts IS 'Agent URLs and test history for each organization';
COMMENT ON COLUMN agent_contexts.auth_token_encrypted IS 'AES-256-GCM encrypted auth token - NEVER expose';
COMMENT ON COLUMN agent_contexts.auth_token_hint IS 'Last 4 chars of token for display (e.g., ****ABCD)';
COMMENT ON COLUMN agent_contexts.tools_discovered IS 'Cached list of tools from last discovery';

-- =====================================================
-- AGENT TEST HISTORY TABLE
-- =====================================================
-- Detailed history of test runs (for debugging and analysis)

CREATE TABLE IF NOT EXISTS agent_test_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to agent context
  agent_context_id UUID NOT NULL REFERENCES agent_contexts(id) ON DELETE CASCADE,

  -- Test details
  scenario TEXT NOT NULL,
  overall_passed BOOLEAN NOT NULL,
  steps_passed INTEGER NOT NULL DEFAULT 0,
  steps_failed INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER,
  summary TEXT,

  -- Options used
  dry_run BOOLEAN DEFAULT TRUE,
  brief TEXT,                                 -- Custom brief if provided

  -- Who ran it
  triggered_by TEXT,                          -- 'user' | 'scheduled' | 'api'
  user_id TEXT,                               -- WorkOS user ID if user-triggered

  -- Results (stored as JSON for flexibility)
  steps_json JSONB,                           -- Full step results
  agent_profile_json JSONB,                   -- Discovered agent profile

  -- Timestamps
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_test_history_agent ON agent_test_history(agent_context_id);
CREATE INDEX IF NOT EXISTS idx_test_history_started ON agent_test_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_history_scenario ON agent_test_history(scenario);
CREATE INDEX IF NOT EXISTS idx_test_history_passed ON agent_test_history(overall_passed);

COMMENT ON TABLE agent_test_history IS 'Detailed test run history for debugging and analysis';
COMMENT ON COLUMN agent_test_history.steps_json IS 'Full TestStepResult[] as JSON';

-- =====================================================
-- VIEW: AGENT CONTEXT SUMMARY
-- =====================================================
-- Summary view for displaying agent contexts to users

CREATE OR REPLACE VIEW agent_context_summary AS
SELECT
  ac.id,
  ac.organization_id,
  ac.agent_url,
  ac.agent_name,
  ac.agent_type,
  ac.protocol,
  ac.auth_token_hint,
  ac.auth_token_encrypted IS NOT NULL as has_auth_token,
  ac.tools_discovered,
  ac.last_test_scenario,
  ac.last_test_passed,
  ac.last_test_summary,
  ac.last_tested_at,
  ac.total_tests_run,
  ac.created_at,
  ac.updated_at,
  -- Aggregated stats from history
  (SELECT COUNT(*) FROM agent_test_history h WHERE h.agent_context_id = ac.id) as history_count,
  (SELECT COUNT(*) FROM agent_test_history h WHERE h.agent_context_id = ac.id AND h.overall_passed) as history_passed_count
FROM agent_contexts ac;

COMMENT ON VIEW agent_context_summary IS 'Agent contexts with token visibility hidden and stats aggregated';
