-- Append-only provenance for administrative certification-attempt resolution.

CREATE TABLE IF NOT EXISTS admin_attempt_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID REFERENCES certification_attempts(id) ON DELETE SET NULL,
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id) ON DELETE CASCADE,
  module_id VARCHAR(10) REFERENCES certification_modules(id),
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('complete', 'cancel')),
  status_before VARCHAR(20) NOT NULL,
  status_after VARCHAR(20) NOT NULL,
  score JSONB,
  reason TEXT NOT NULL,
  teaching_checkpoint_id UUID REFERENCES teaching_checkpoints(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, action)
);

CREATE INDEX IF NOT EXISTS idx_admin_attempt_resolutions_user_module
  ON admin_attempt_resolutions(workos_user_id, module_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_attempt_resolutions_admin
  ON admin_attempt_resolutions(admin_user_id, created_at DESC);

COMMENT ON TABLE admin_attempt_resolutions IS
  'Append-only audit trail for exactly-once administrative certification-attempt transitions.';

-- Preserve provenance for admin resolutions made before this table existed.
-- These rows already carry their reason inside certification_attempts.scores.
INSERT INTO admin_attempt_resolutions (
  attempt_id,
  workos_user_id,
  module_id,
  admin_user_id,
  action,
  status_before,
  status_after,
  score,
  reason,
  created_at
)
SELECT
  ca.id,
  ca.workos_user_id,
  ca.module_id,
  'legacy-admin-repair',
  CASE WHEN ca.scores->>'_admin_completed' = 'true'
       THEN 'complete' ELSE 'cancel' END,
  'in_progress',
  ca.status,
  ca.scores,
  COALESCE(NULLIF(ca.scores->>'_reason', ''), 'Legacy administrative attempt resolution'),
  COALESCE(ca.completed_at, ca.created_at)
FROM certification_attempts ca
WHERE ca.scores->>'_admin_completed' = 'true'
   OR ca.scores->>'_admin_cancelled' = 'true'
ON CONFLICT (attempt_id, action) DO NOTHING;
