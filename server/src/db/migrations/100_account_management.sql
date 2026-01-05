-- Account Management: User stakeholders + Action items
-- Extends org_stakeholders concept to individual users
-- Adds momentum-aware action items for account management

-- =====================================================
-- USER STAKEHOLDERS (parallels org_stakeholders)
-- =====================================================

CREATE TABLE IF NOT EXISTS user_stakeholders (
  id SERIAL PRIMARY KEY,
  -- The user being tracked (can be slack or workos id)
  slack_user_id VARCHAR(255),
  workos_user_id VARCHAR(255),

  -- The admin who owns/is connected to this user
  stakeholder_id VARCHAR(255) NOT NULL,  -- admin's workos_user_id
  stakeholder_name TEXT NOT NULL,
  stakeholder_email TEXT,

  -- Role: owner (primary responsibility), interested (wants updates), connected (has relationship)
  role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'interested', 'connected')),

  -- How they became connected
  assignment_reason VARCHAR(50),  -- outreach, conversation, onboarding, manual

  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Each user can only have one stakeholder per role type
  UNIQUE(slack_user_id, stakeholder_id),
  UNIQUE(workos_user_id, stakeholder_id),

  -- Must have at least one user identifier
  CHECK (slack_user_id IS NOT NULL OR workos_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_user_stakeholders_slack ON user_stakeholders(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_user_stakeholders_workos ON user_stakeholders(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_user_stakeholders_stakeholder ON user_stakeholders(stakeholder_id);
CREATE INDEX IF NOT EXISTS idx_user_stakeholders_role ON user_stakeholders(role);

COMMENT ON TABLE user_stakeholders IS 'Tracks admin team members responsible for or connected to individual users';

-- =====================================================
-- ACTION ITEMS (momentum-aware tasks)
-- =====================================================

CREATE TABLE IF NOT EXISTS action_items (
  id SERIAL PRIMARY KEY,

  -- Who/what it's about (user OR org, not both)
  slack_user_id VARCHAR(255),
  workos_user_id VARCHAR(255),
  org_id VARCHAR(255),

  -- Who owns this action (defaults to account owner)
  assigned_to VARCHAR(255),  -- admin's workos_user_id

  -- What kind of action
  action_type VARCHAR(50) NOT NULL CHECK (action_type IN (
    'nudge',        -- No response/activity, time to follow up
    'warm_lead',    -- Some engagement but no conversion
    'momentum',     -- Good activity happening, opportunity to engage
    'feedback',     -- Feature request or suggestion captured
    'alert',        -- Something needs immediate attention (frustration, issue)
    'follow_up',    -- Explicit commitment to follow up
    'celebration'   -- Positive event (conversion, milestone)
  )),

  priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),

  -- What happened
  title TEXT NOT NULL,
  description TEXT,

  -- Rich context (activity since trigger, clicks, etc.)
  context JSONB DEFAULT '{}',

  -- What triggered this action item
  trigger_type VARCHAR(50),  -- outreach, conversation, system, manual, insight
  trigger_id VARCHAR(255),   -- outreach_id, thread_id, etc.
  trigger_data JSONB,        -- snapshot of trigger state

  -- Status
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'completed', 'dismissed')),
  snoozed_until TIMESTAMP WITH TIME ZONE,

  -- Resolution
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by VARCHAR(255),
  resolution_note TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Must have at least one subject
  CHECK (slack_user_id IS NOT NULL OR workos_user_id IS NOT NULL OR org_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_action_items_slack_user ON action_items(slack_user_id) WHERE slack_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_items_workos_user ON action_items(workos_user_id) WHERE workos_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_items_org ON action_items(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_items_assigned ON action_items(assigned_to);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);
CREATE INDEX IF NOT EXISTS idx_action_items_type ON action_items(action_type);
CREATE INDEX IF NOT EXISTS idx_action_items_priority ON action_items(priority);
CREATE INDEX IF NOT EXISTS idx_action_items_created ON action_items(created_at DESC);

-- Prevent duplicate action items from same trigger
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_items_trigger
  ON action_items(trigger_type, trigger_id)
  WHERE trigger_type IS NOT NULL AND trigger_id IS NOT NULL AND status = 'open';

COMMENT ON TABLE action_items IS 'Momentum-aware action items for account management';

-- =====================================================
-- VIEWS FOR ACCOUNT MANAGEMENT
-- =====================================================

-- My accounts view: users and orgs I'm responsible for
CREATE OR REPLACE VIEW my_accounts AS
SELECT
  'user' as account_type,
  us.stakeholder_id,
  us.role,
  COALESCE(us.workos_user_id, us.slack_user_id) as account_id,
  COALESCE(u.first_name || ' ' || u.last_name, sm.slack_real_name, sm.slack_display_name) as account_name,
  COALESCE(u.email, sm.slack_email) as account_email,
  o.name as org_name,
  us.assignment_reason,
  us.created_at as assigned_at,
  -- Activity metrics
  sm.last_slack_activity_at as last_slack_activity,
  (SELECT MAX(at.created_at) FROM addie_threads at WHERE
    (at.user_type = 'slack' AND at.user_id = us.slack_user_id)
    OR (at.user_type = 'workos' AND at.user_id = us.workos_user_id)
  ) as last_conversation,
  (SELECT COUNT(*) FROM action_items ai WHERE
    (ai.slack_user_id = us.slack_user_id OR ai.workos_user_id = us.workos_user_id)
    AND ai.status = 'open'
  ) as open_action_items
FROM user_stakeholders us
LEFT JOIN users u ON u.workos_user_id = us.workos_user_id
LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = us.slack_user_id
LEFT JOIN organization_memberships om ON om.workos_user_id = us.workos_user_id
LEFT JOIN organizations o ON o.workos_organization_id = om.workos_organization_id

UNION ALL

SELECT
  'org' as account_type,
  os.user_id as stakeholder_id,
  os.role,
  os.organization_id as account_id,
  o.name as account_name,
  NULL as account_email,
  o.name as org_name,
  NULL as assignment_reason,
  os.created_at as assigned_at,
  NULL as last_slack_activity,
  NULL as last_conversation,
  (SELECT COUNT(*) FROM action_items ai WHERE
    ai.org_id = os.organization_id AND ai.status = 'open'
  ) as open_action_items
FROM org_stakeholders os
JOIN organizations o ON o.workos_organization_id = os.organization_id;

-- Action items with account context
CREATE OR REPLACE VIEW action_items_with_context AS
SELECT
  ai.*,
  -- User info
  COALESCE(u.first_name || ' ' || u.last_name, sm.slack_real_name, sm.slack_display_name) as user_name,
  COALESCE(u.email, sm.slack_email) as user_email,
  -- Org info
  o.name as org_name,
  -- Assignee info
  au.first_name || ' ' || au.last_name as assigned_to_name,
  au.email as assigned_to_email
FROM action_items ai
LEFT JOIN users u ON u.workos_user_id = ai.workos_user_id
LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = ai.slack_user_id
LEFT JOIN organizations o ON o.workos_organization_id = ai.org_id
LEFT JOIN users au ON au.workos_user_id = ai.assigned_to;

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Auto-assign user to admin when they interact
CREATE OR REPLACE FUNCTION assign_user_stakeholder(
  p_slack_user_id VARCHAR(255),
  p_workos_user_id VARCHAR(255),
  p_stakeholder_id VARCHAR(255),
  p_stakeholder_name TEXT,
  p_stakeholder_email TEXT,
  p_reason VARCHAR(50)
) RETURNS void AS $$
BEGIN
  -- Only insert if no owner exists yet
  INSERT INTO user_stakeholders (
    slack_user_id, workos_user_id,
    stakeholder_id, stakeholder_name, stakeholder_email,
    role, assignment_reason
  )
  VALUES (
    p_slack_user_id, p_workos_user_id,
    p_stakeholder_id, p_stakeholder_name, p_stakeholder_email,
    'owner', p_reason
  )
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Get owner for a user
CREATE OR REPLACE FUNCTION get_user_owner(
  p_slack_user_id VARCHAR(255),
  p_workos_user_id VARCHAR(255)
) RETURNS VARCHAR(255) AS $$
DECLARE
  v_owner VARCHAR(255);
BEGIN
  SELECT stakeholder_id INTO v_owner
  FROM user_stakeholders
  WHERE (slack_user_id = p_slack_user_id OR workos_user_id = p_workos_user_id)
    AND role = 'owner'
  LIMIT 1;

  RETURN v_owner;
END;
$$ LANGUAGE plpgsql;
