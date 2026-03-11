-- Teaching checkpoints: Addie saves teaching state at natural boundaries
-- Enables cross-session resume and context recovery after message trimming

CREATE TABLE IF NOT EXISTS teaching_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  module_id VARCHAR(10) NOT NULL REFERENCES certification_modules(id),
  thread_id TEXT,
  concepts_covered TEXT[] DEFAULT '{}',
  concepts_remaining TEXT[] DEFAULT '{}',
  learner_strengths TEXT[] DEFAULT '{}',
  learner_gaps TEXT[] DEFAULT '{}',
  current_phase VARCHAR(20) NOT NULL DEFAULT 'teaching',
  preliminary_scores JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_teaching_checkpoints_user_module
  ON teaching_checkpoints(workos_user_id, module_id, created_at DESC);
