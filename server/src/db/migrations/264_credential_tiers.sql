-- Three-tier credential system for AdCP certification
-- Level 1: Basics (free), Level 2: Practitioner (role-agnostic), Level 3: Specialist (protocol-specific)

-- Widen badges.icon and badges.category to support text icon names
ALTER TABLE badges ALTER COLUMN icon TYPE VARCHAR(50);
ALTER TABLE badges ALTER COLUMN category TYPE VARCHAR(50);

-- =====================================================
-- CERTIFICATION CREDENTIALS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS certification_credentials (
  id VARCHAR(50) PRIMARY KEY,
  tier INTEGER NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  required_modules TEXT[] NOT NULL DEFAULT '{}',
  requires_any_track_complete BOOLEAN DEFAULT false,
  requires_credential VARCHAR(50) REFERENCES certification_credentials(id),
  certifier_group_id VARCHAR(100),
  badge_id VARCHAR(50) REFERENCES badges(id),
  sort_order INTEGER DEFAULT 0
);

COMMENT ON TABLE certification_credentials IS 'Defines the 3-tier credential structure: Basics, Practitioner, Specialist';
COMMENT ON COLUMN certification_credentials.requires_any_track_complete IS 'If true, requires at least one specialization track (B/C/D) fully completed';
COMMENT ON COLUMN certification_credentials.requires_credential IS 'Must hold this credential first (e.g., Specialist requires Practitioner)';

-- Track which credentials users have earned
CREATE TABLE IF NOT EXISTS user_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  credential_id VARCHAR(50) NOT NULL REFERENCES certification_credentials(id),
  awarded_at TIMESTAMPTZ DEFAULT NOW(),
  certifier_credential_id VARCHAR(100),
  certifier_public_id VARCHAR(200),
  UNIQUE(workos_user_id, credential_id)
);

CREATE INDEX IF NOT EXISTS idx_user_credentials_user ON user_credentials(workos_user_id);

COMMENT ON TABLE user_credentials IS 'Credentials earned by users, with Certifier integration links';

-- =====================================================
-- BADGES — replace role-based with protocol-based
-- =====================================================

-- Remove old role-based certification badges
DELETE FROM user_badges WHERE badge_id IN (
  'adcp_certified_publisher', 'adcp_certified_buyer', 'adcp_certified_platform'
);
DELETE FROM badges WHERE id IN (
  'adcp_certified_publisher', 'adcp_certified_buyer', 'adcp_certified_platform'
);

-- Insert 6 protocol-based badges
INSERT INTO badges (id, name, description, icon, category) VALUES
  ('adcp_basics', 'AdCP basics', 'Completed AdCP foundations — understands agentic advertising concepts and protocol architecture', 'foundations', 'certification'),
  ('adcp_practitioner', 'AdCP practitioner', 'Completed foundations plus a specialization track with interactive exercises', 'practitioner', 'certification'),
  ('adcp_specialist_media_buy', 'AdCP specialist — Media buy', 'Protocol specialist in media buy transactions, pricing, and multi-agent orchestration', 'specialist', 'certification'),
  ('adcp_specialist_creative', 'AdCP specialist — Creative', 'Protocol specialist in creative workflows, format compliance, and cross-platform adaptation', 'specialist', 'certification'),
  ('adcp_specialist_signals', 'AdCP specialist — Signals', 'Protocol specialist in measurement, attribution, and optimization loops', 'specialist', 'certification'),
  ('adcp_specialist_governance', 'AdCP specialist — Governance', 'Protocol specialist in brand safety, supply chain compliance, and content standards', 'specialist', 'certification')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  category = EXCLUDED.category;

-- =====================================================
-- CREDENTIAL DEFINITIONS
-- =====================================================

INSERT INTO certification_credentials (id, tier, name, description, required_modules, requires_any_track_complete, requires_credential, badge_id, certifier_group_id, sort_order) VALUES
  ('basics', 1, 'AdCP Basics',
   'Foundational understanding of agentic advertising and AdCP architecture. Free and open to everyone.',
   '{A1,A2}', false, NULL, 'adcp_basics', '01kk46ghdkt4c7bq6zvtpgpvpq', 1),

  ('practitioner', 2, 'AdCP Practitioner',
   'Deep, role-specific AdCP knowledge with hands-on exercises against live sandbox agents. Requires foundations plus at least one specialization track.',
   '{A1,A2,A3}', true, NULL, 'adcp_practitioner', '01kk46mmaa4tydwk5a1nwga9jx', 2),

  ('specialist_media_buy', 3, 'AdCP Specialist — Media buy',
   'Protocol specialist in media buy transactions. Demonstrates mastery of get_products, create_media_buy, update_media_buy, and delivery reporting through capstone lab and adaptive exam.',
   '{E1}', false, 'practitioner', 'adcp_specialist_media_buy', '01kk46pgtf650kv3d8598hb5sn', 3),

  ('specialist_creative', 3, 'AdCP Specialist — Creative',
   'Protocol specialist in creative workflows. Demonstrates mastery of list_creative_formats, sync_creatives, build_creative, and preview_creative through capstone lab and adaptive exam.',
   '{E2}', false, 'practitioner', 'adcp_specialist_creative', '01kk46s85k778h4dfnxgwem7bm', 4),

  ('specialist_signals', 3, 'AdCP Specialist — Signals',
   'Protocol specialist in measurement and signals. Demonstrates mastery of get_signals, activate_signal, and optimization loops through capstone lab and adaptive exam.',
   '{E3}', false, 'practitioner', 'adcp_specialist_signals', NULL, 5),

  ('specialist_governance', 3, 'AdCP Specialist — Governance',
   'Protocol specialist in governance and compliance. Demonstrates mastery of property lists, content standards, calibrate_content, and brand safety through capstone lab and adaptive exam.',
   '{E4}', false, 'practitioner', 'adcp_specialist_governance', '01kk46tkmsm81hax6q3hr5w8ft', 6)
ON CONFLICT (id) DO UPDATE SET
  tier = EXCLUDED.tier,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  required_modules = EXCLUDED.required_modules,
  requires_any_track_complete = EXCLUDED.requires_any_track_complete,
  requires_credential = EXCLUDED.requires_credential,
  badge_id = EXCLUDED.badge_id,
  certifier_group_id = EXCLUDED.certifier_group_id,
  sort_order = EXCLUDED.sort_order;
