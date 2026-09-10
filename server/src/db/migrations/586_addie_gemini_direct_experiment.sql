-- Product A/B outcomes; no transcript copy or separate evaluation infrastructure.
CREATE TABLE IF NOT EXISTS addie_chat_experiment_turns (
  id UUID PRIMARY KEY,
  experiment TEXT NOT NULL,
  thread_id UUID NOT NULL REFERENCES addie_threads(thread_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('control', 'gemini')),
  cohort TEXT NOT NULL CHECK (cohort IN ('staff', 'eligible', 'existing')),
  exclusion_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  first_visible_ms INTEGER,
  total_ms INTEGER,
  router_ms INTEGER,
  provider_calls INTEGER,
  estimated_cost_micros BIGINT,
  usage_complete BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_reason TEXT,
  actual_provider TEXT,
  actual_model TEXT,
  failed BOOLEAN,
  tool_errors INTEGER,
  usage JSONB,
  assistant_message_id UUID REFERENCES addie_thread_messages(message_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_addie_chat_experiment_turns_experiment
  ON addie_chat_experiment_turns (experiment, started_at);
CREATE INDEX IF NOT EXISTS idx_addie_chat_experiment_turns_thread
  ON addie_chat_experiment_turns (thread_id);
