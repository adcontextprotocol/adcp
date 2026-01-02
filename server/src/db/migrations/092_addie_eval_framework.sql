-- Eval framework for testing rule changes against historical interactions

-- Tracks each evaluation run
CREATE TABLE addie_eval_runs (
  id SERIAL PRIMARY KEY,

  -- What we're testing
  proposed_rule_ids INTEGER[] NOT NULL,
  proposed_rules_snapshot JSONB NOT NULL,
  baseline_config_version_id INTEGER,

  -- Selection criteria used
  selection_criteria JSONB NOT NULL,

  -- Execution status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,

  -- Results summary
  total_interactions INTEGER DEFAULT 0,
  interactions_evaluated INTEGER DEFAULT 0,
  interactions_affected INTEGER DEFAULT 0,

  -- Aggregated metrics
  metrics JSONB,

  -- Audit
  created_by TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Per-interaction eval results
CREATE TABLE addie_eval_results (
  id SERIAL PRIMARY KEY,
  eval_run_id INTEGER NOT NULL REFERENCES addie_eval_runs(id) ON DELETE CASCADE,
  message_id UUID NOT NULL,
  thread_id UUID NOT NULL,

  -- Original execution data (copied from thread_messages)
  original_input TEXT,
  original_response TEXT,
  original_rating INTEGER,
  original_tools_used TEXT[],
  original_router_decision JSONB,
  original_latency_ms INTEGER,

  -- New execution with proposed rules
  new_response TEXT,
  new_tools_used TEXT[],
  new_router_decision JSONB,
  new_latency_ms INTEGER,
  new_tokens_input INTEGER,
  new_tokens_output INTEGER,

  -- Comparison flags
  routing_changed BOOLEAN DEFAULT FALSE,
  tools_changed BOOLEAN DEFAULT FALSE,
  response_changed BOOLEAN DEFAULT FALSE,

  -- Human review
  review_verdict TEXT CHECK (review_verdict IN ('improved', 'same', 'worse', 'uncertain')),
  review_notes TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_addie_eval_runs_status ON addie_eval_runs(status);
CREATE INDEX idx_addie_eval_runs_created ON addie_eval_runs(created_at DESC);
CREATE INDEX idx_addie_eval_results_run ON addie_eval_results(eval_run_id);
CREATE INDEX idx_addie_eval_results_verdict ON addie_eval_results(review_verdict) WHERE review_verdict IS NOT NULL;

COMMENT ON TABLE addie_eval_runs IS 'Evaluation runs for testing proposed rule changes against historical interactions';
COMMENT ON TABLE addie_eval_results IS 'Per-interaction results from evaluation runs, with original vs new comparison';
