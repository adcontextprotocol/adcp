-- Learner feedback collected after module completion
-- Addie asks "how was that experience?" and records responses

CREATE TABLE IF NOT EXISTS certification_learner_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  module_id VARCHAR(10) NOT NULL REFERENCES certification_modules(id),
  feedback TEXT NOT NULL,
  sentiment VARCHAR(20) DEFAULT 'mixed' CHECK (sentiment IN ('positive', 'mixed', 'negative')),
  thread_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cert_feedback_module ON certification_learner_feedback(module_id);
CREATE INDEX IF NOT EXISTS idx_cert_feedback_user ON certification_learner_feedback(workos_user_id);

COMMENT ON TABLE certification_learner_feedback IS 'Learner feedback collected after certification module completion';
