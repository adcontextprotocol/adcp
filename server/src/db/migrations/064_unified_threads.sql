-- Migration: 055_unified_threads.sql
-- Unified thread model for all Addie conversations (Slack, Web, A2A, etc.)
--
-- This consolidates:
-- - addie_interactions (Slack - flat model)
-- - addie_conversations + addie_messages (Web - hierarchical model)
-- - addie_thread_context (Bolt thread context)
--
-- Into a single unified model that works across all channels.

-- =====================================================
-- UNIFIED THREADS TABLE
-- =====================================================
-- A thread is a conversation session with Addie, regardless of channel

CREATE TABLE IF NOT EXISTS addie_threads (
  thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Channel identification
  channel VARCHAR(50) NOT NULL,  -- 'slack', 'web', 'a2a', 'email', etc.

  -- External ID for channel-specific lookups
  -- Slack: "channel_id:thread_ts", Web: conversation_id, A2A: task_id
  external_id VARCHAR(500) NOT NULL,

  -- User identification (polymorphic)
  user_type VARCHAR(50) NOT NULL DEFAULT 'slack',  -- 'slack', 'workos', 'agent', 'anonymous'
  user_id VARCHAR(255),  -- Slack user ID, WorkOS user ID, agent URL, or NULL for anonymous
  user_display_name VARCHAR(255),  -- Display name for UI

  -- Thread context (what the user was viewing/doing when they started)
  -- Slack: channel they're viewing
  -- Web: referring page
  -- A2A: agent card info
  context JSONB DEFAULT '{}',

  -- Thread metadata
  title VARCHAR(500),  -- Auto-generated or set by setTitle()
  message_count INTEGER DEFAULT 0,

  -- Review workflow
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by VARCHAR(255),  -- WorkOS user ID
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_notes TEXT,

  -- Flagging
  flagged BOOLEAN DEFAULT FALSE,
  flag_reason TEXT,

  -- Experiment tracking
  experiment_id INTEGER REFERENCES addie_experiments(id),
  experiment_group VARCHAR(20) CHECK (experiment_group IN ('control', 'variant')),
  active_rules_snapshot JSONB,

  -- Impersonation (admin testing)
  impersonator_user_id VARCHAR(255),  -- WorkOS user ID of admin
  impersonation_reason TEXT,

  -- Timestamps
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Unique constraint on channel + external_id
  UNIQUE(channel, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_addie_threads_channel ON addie_threads(channel);
CREATE INDEX IF NOT EXISTS idx_addie_threads_user ON addie_threads(user_type, user_id);
CREATE INDEX IF NOT EXISTS idx_addie_threads_external ON addie_threads(external_id);
CREATE INDEX IF NOT EXISTS idx_addie_threads_started ON addie_threads(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_addie_threads_last_message ON addie_threads(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_addie_threads_flagged ON addie_threads(flagged) WHERE flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_addie_threads_unreviewed ON addie_threads(reviewed) WHERE reviewed = FALSE;
CREATE INDEX IF NOT EXISTS idx_addie_threads_experiment ON addie_threads(experiment_id) WHERE experiment_id IS NOT NULL;

-- =====================================================
-- UNIFIED MESSAGES TABLE
-- =====================================================
-- Individual messages within a thread

CREATE TABLE IF NOT EXISTS addie_thread_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES addie_threads(thread_id) ON DELETE CASCADE,

  -- Message role
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),

  -- Content
  content TEXT NOT NULL,

  -- For user messages: sanitized input
  content_sanitized TEXT,

  -- Tool usage (for assistant messages)
  tools_used TEXT[],  -- Array of tool names used
  tool_calls JSONB,   -- Detailed tool call info [{name, input, result}]
  knowledge_ids INTEGER[],  -- References to addie_knowledge.id

  -- Performance metrics
  model VARCHAR(100),
  latency_ms INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,

  -- Flagging (per-message)
  flagged BOOLEAN DEFAULT FALSE,
  flag_reason TEXT,

  -- Feedback (per-message rating)
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  rating_category VARCHAR(50),  -- 'accuracy', 'helpfulness', 'completeness', 'tone'
  rating_notes TEXT,
  feedback_tags JSONB DEFAULT '[]',  -- ['missing_info', 'wrong_answer', 'too_verbose']
  improvement_suggestion TEXT,
  rated_by VARCHAR(255),  -- WorkOS user ID or Slack user ID
  rated_at TIMESTAMP WITH TIME ZONE,

  -- Outcome tracking (for assistant messages)
  outcome VARCHAR(50) CHECK (outcome IN (
    'resolved',
    'partially_resolved',
    'unresolved',
    'escalated',
    'unknown'
  )),
  user_sentiment VARCHAR(20) CHECK (user_sentiment IN (
    'positive',
    'neutral',
    'negative',
    'unknown'
  )),
  intent_category VARCHAR(100),  -- Categorization of user intent

  -- Ordering
  sequence_number INTEGER NOT NULL,  -- Message order within thread (1, 2, 3...)

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_addie_thread_messages_thread ON addie_thread_messages(thread_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_addie_thread_messages_created ON addie_thread_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_addie_thread_messages_role ON addie_thread_messages(role);
CREATE INDEX IF NOT EXISTS idx_addie_thread_messages_flagged ON addie_thread_messages(flagged) WHERE flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_addie_thread_messages_rating ON addie_thread_messages(rating) WHERE rating IS NOT NULL;

-- =====================================================
-- UPDATE TRIGGER FOR THREAD STATS
-- =====================================================

CREATE OR REPLACE FUNCTION update_thread_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE addie_threads
    SET
      message_count = message_count + 1,
      last_message_at = NEW.created_at,
      updated_at = NOW()
    WHERE thread_id = NEW.thread_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_thread_stats ON addie_thread_messages;
CREATE TRIGGER trigger_update_thread_stats
AFTER INSERT ON addie_thread_messages
FOR EACH ROW
EXECUTE FUNCTION update_thread_stats();

-- =====================================================
-- VIEWS FOR BACKWARD COMPATIBILITY & ANALYTICS
-- =====================================================

-- Combined thread view with latest message info
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
   WHERE thread_id = t.thread_id AND latency_ms IS NOT NULL) as total_latency_ms
FROM addie_threads t;

-- Channel-specific stats view
CREATE OR REPLACE VIEW addie_channel_stats AS
SELECT
  channel,
  COUNT(DISTINCT thread_id) as total_threads,
  COUNT(DISTINCT user_id) as unique_users,
  SUM(message_count) as total_messages,
  COUNT(*) FILTER (WHERE flagged) as flagged_threads,
  COUNT(*) FILTER (WHERE reviewed) as reviewed_threads,
  COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours') as threads_last_24h,
  COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days') as threads_last_7d
FROM addie_threads
GROUP BY channel;

-- Daily thread stats view
CREATE OR REPLACE VIEW addie_daily_thread_stats AS
SELECT
  DATE_TRUNC('day', started_at) as day,
  channel,
  COUNT(*) as threads,
  SUM(message_count) as messages,
  COUNT(*) FILTER (WHERE flagged) as flagged,
  ROUND(AVG(message_count)::numeric, 1) as avg_messages_per_thread
FROM addie_threads
GROUP BY DATE_TRUNC('day', started_at), channel
ORDER BY day DESC, channel;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE addie_threads IS 'Unified conversation threads with Addie across all channels (Slack, Web, A2A, etc.)';
COMMENT ON TABLE addie_thread_messages IS 'Individual messages within Addie conversation threads';

COMMENT ON COLUMN addie_threads.channel IS 'Source channel: slack, web, a2a, email';
COMMENT ON COLUMN addie_threads.external_id IS 'Channel-specific ID: Slack=channel:thread_ts, Web=conversation_id, A2A=task_id';
COMMENT ON COLUMN addie_threads.user_type IS 'User ID type: slack, workos, agent, anonymous';
COMMENT ON COLUMN addie_threads.context IS 'Channel-specific context JSON (Slack viewing channel, web referrer, etc.)';

COMMENT ON COLUMN addie_thread_messages.sequence_number IS 'Message order within thread, starting at 1';
COMMENT ON COLUMN addie_thread_messages.tools_used IS 'Array of tool names invoked';
COMMENT ON COLUMN addie_thread_messages.tool_calls IS 'Detailed tool call info: [{name, input, result}]';
