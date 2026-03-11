-- AdCP certification program: tracks, modules, learner progress, and credential issuance

-- =====================================================
-- CERTIFICATION TRACKS
-- =====================================================

CREATE TABLE IF NOT EXISTS certification_tracks (
  id VARCHAR(10) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  badge_type VARCHAR(50),
  certifier_group_id VARCHAR(100),
  sort_order INTEGER DEFAULT 0
);

COMMENT ON TABLE certification_tracks IS 'Certification specialization tracks (A=Foundations, B=Publisher, C=Buyer, D=Platform, E=Capstone)';

-- =====================================================
-- CERTIFICATION MODULES
-- =====================================================

CREATE TABLE IF NOT EXISTS certification_modules (
  id VARCHAR(10) PRIMARY KEY,
  track_id VARCHAR(10) NOT NULL REFERENCES certification_tracks(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  format VARCHAR(20) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_free BOOLEAN DEFAULT false,
  prerequisites TEXT[] DEFAULT '{}',
  lesson_plan JSONB,
  exercise_definitions JSONB,
  assessment_criteria JSONB
);

COMMENT ON TABLE certification_modules IS 'Individual learning modules within certification tracks';

-- =====================================================
-- LEARNER PROGRESS
-- =====================================================

CREATE TABLE IF NOT EXISTS learner_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  module_id VARCHAR(10) NOT NULL REFERENCES certification_modules(id),
  status VARCHAR(20) NOT NULL DEFAULT 'not_started',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  score JSONB,
  addie_thread_id TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workos_user_id, module_id)
);

CREATE INDEX IF NOT EXISTS idx_learner_progress_user ON learner_progress(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_learner_progress_module ON learner_progress(module_id);

COMMENT ON TABLE learner_progress IS 'Per-user progress through certification modules';

-- =====================================================
-- CERTIFICATION ATTEMPTS
-- =====================================================

CREATE TABLE IF NOT EXISTS certification_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  track_id VARCHAR(10) NOT NULL REFERENCES certification_tracks(id),
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  scores JSONB,
  overall_score INTEGER,
  passing BOOLEAN,
  addie_thread_id TEXT,
  certifier_credential_id VARCHAR(100),
  certifier_public_id VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_certification_attempts_user ON certification_attempts(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_certification_attempts_track ON certification_attempts(track_id, status);

COMMENT ON TABLE certification_attempts IS 'Capstone exam attempts and credential issuance records';

-- =====================================================
-- CERTIFICATION BADGES (extend existing badge system)
-- =====================================================

INSERT INTO badges (id, name, description, icon, category) VALUES
  ('adcp_certified_publisher', 'AdCP certified — Publisher', 'Passed the AdCP Publisher/Seller certification exam', '📡', 'certification'),
  ('adcp_certified_buyer', 'AdCP certified — Buyer', 'Passed the AdCP Buyer/Brand certification exam', '🛒', 'certification'),
  ('adcp_certified_platform', 'AdCP certified — Platform', 'Passed the AdCP Platform/Intermediary certification exam', '🔧', 'certification')
ON CONFLICT (id) DO NOTHING;
