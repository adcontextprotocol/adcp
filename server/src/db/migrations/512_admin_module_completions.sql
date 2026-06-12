-- Append-only provenance for admin certification module completions.

CREATE TABLE IF NOT EXISTS admin_module_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  module_id VARCHAR(10) NOT NULL REFERENCES certification_modules(id),
  admin_user_id TEXT NOT NULL,
  completed_by TEXT NOT NULL DEFAULT 'admin' CHECK (completed_by = 'admin'),
  addie_thread_id TEXT NOT NULL,
  score JSONB NOT NULL,
  note TEXT,
  teaching_checkpoint_id UUID REFERENCES teaching_checkpoints(id),
  learner_progress_id UUID REFERENCES learner_progress(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_module_completions_user_module
  ON admin_module_completions(workos_user_id, module_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_module_completions_admin
  ON admin_module_completions(admin_user_id, created_at DESC);

COMMENT ON TABLE admin_module_completions IS
  'Append-only audit trail for admin certification module completions.';
