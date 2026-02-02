-- Moltbook Decision Logging
-- Captures Addie's reasoning when evaluating posts for engagement

CREATE TABLE moltbook_decisions (
  id SERIAL PRIMARY KEY,

  -- What was evaluated
  moltbook_post_id TEXT NOT NULL,
  post_title TEXT,
  post_author TEXT,

  -- Decision details
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'relevance',      -- Was the post relevant to advertising?
    'comment',        -- Did we generate/post a comment?
    'upvote',         -- Did we upvote a comment?
    'reply',          -- Did we reply to someone?
    'share'           -- Did we share to Slack?
  )),

  outcome TEXT NOT NULL CHECK (outcome IN ('engaged', 'skipped')),

  -- Reasoning
  reason TEXT NOT NULL,
  decision_method TEXT NOT NULL CHECK (decision_method IN ('llm', 'rule', 'rate_limit')),

  -- Content (for comment/reply decisions)
  generated_content TEXT,
  content_posted BOOLEAN DEFAULT FALSE,

  -- LLM metadata (when decision_method = 'llm')
  model TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  latency_ms INTEGER,

  -- Context
  job_run_id UUID,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for admin UI queries
CREATE INDEX idx_moltbook_decisions_created ON moltbook_decisions(created_at DESC);
CREATE INDEX idx_moltbook_decisions_type ON moltbook_decisions(decision_type, outcome);
CREATE INDEX idx_moltbook_decisions_post ON moltbook_decisions(moltbook_post_id);
CREATE INDEX idx_moltbook_decisions_job ON moltbook_decisions(job_run_id);

COMMENT ON TABLE moltbook_decisions IS 'Logs Addie reasoning when evaluating Moltbook posts for engagement';
