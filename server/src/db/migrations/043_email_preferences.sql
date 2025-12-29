-- Migration: 038_email_preferences.sql
-- User email preferences and unsubscribe management

-- Email categories that users can subscribe/unsubscribe from
-- Transactional emails (welcome, security) are always sent and not in this list
CREATE TABLE IF NOT EXISTS email_categories (
  id VARCHAR(50) PRIMARY KEY,  -- e.g., 'newsletter', 'working_groups', 'releases'
  name VARCHAR(100) NOT NULL,
  description TEXT,
  default_enabled BOOLEAN DEFAULT true,  -- Default preference for new users
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User email preferences - which categories each user wants
CREATE TABLE IF NOT EXISTS user_email_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,  -- Denormalized for unsubscribe without auth

  -- Unsubscribe token for one-click unsubscribe (no auth required)
  unsubscribe_token VARCHAR(64) NOT NULL UNIQUE,

  -- Global opt-out (unsubscribes from ALL non-transactional emails)
  global_unsubscribe BOOLEAN DEFAULT false,
  global_unsubscribe_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(workos_user_id)
);

-- Per-category preferences (only stores overrides from default)
CREATE TABLE IF NOT EXISTS user_email_category_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_preference_id UUID NOT NULL REFERENCES user_email_preferences(id) ON DELETE CASCADE,
  category_id VARCHAR(50) NOT NULL REFERENCES email_categories(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(user_preference_id, category_id)
);

-- Email templates that admins can edit
CREATE TABLE IF NOT EXISTS email_templates (
  id VARCHAR(50) PRIMARY KEY,  -- e.g., 'welcome_member', 'newsletter'
  name VARCHAR(100) NOT NULL,
  description TEXT,

  -- Template content (supports {{variable}} substitution)
  subject_template VARCHAR(500) NOT NULL,
  html_template TEXT NOT NULL,
  text_template TEXT NOT NULL,

  -- Which category this template belongs to (null = transactional)
  category_id VARCHAR(50) REFERENCES email_categories(id),

  -- Template variables documentation
  available_variables JSONB,  -- e.g., {"firstName": "User's first name", "orgName": "Organization name"}

  -- Versioning
  version INTEGER DEFAULT 1,
  last_edited_by VARCHAR(255),
  last_edited_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Email campaigns (one-off sends like newsletters)
CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Campaign details
  name VARCHAR(200) NOT NULL,
  description TEXT,

  -- Content
  subject VARCHAR(500) NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT NOT NULL,

  -- Targeting
  category_id VARCHAR(50) NOT NULL REFERENCES email_categories(id),
  target_audience VARCHAR(50) DEFAULT 'all_subscribers',  -- all_subscribers, members_only, non_members

  -- Status
  status VARCHAR(20) DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),

  -- Scheduling
  scheduled_for TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Stats (updated as sends complete)
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  unsubscribe_count INTEGER DEFAULT 0,

  -- Who created/edited
  created_by VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_email_prefs_user ON user_email_preferences(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_user_email_prefs_email ON user_email_preferences(email);
CREATE INDEX IF NOT EXISTS idx_user_email_prefs_token ON user_email_preferences(unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_category ON email_campaigns(category_id);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_user_email_preferences_updated_at ON user_email_preferences;
CREATE TRIGGER update_user_email_preferences_updated_at
  BEFORE UPDATE ON user_email_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_email_templates_updated_at ON email_templates;
CREATE TRIGGER update_email_templates_updated_at
  BEFORE UPDATE ON email_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_email_campaigns_updated_at ON email_campaigns;
CREATE TRIGGER update_email_campaigns_updated_at
  BEFORE UPDATE ON email_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Seed default email categories
INSERT INTO email_categories (id, name, description, default_enabled, sort_order) VALUES
  ('newsletter', 'Newsletter', 'Monthly newsletter with industry updates and member news', true, 1),
  ('working_groups', 'Working Group Updates', 'Summaries and updates from working groups you''re part of', true, 2),
  ('releases', 'Release Announcements', 'New AdCP releases, features, and protocol updates', true, 3),
  ('member_directory', 'Member Directory Updates', 'New members joining and member profile updates', true, 4),
  ('events', 'Events & Webinars', 'Upcoming events, webinars, and community gatherings', true, 5)
ON CONFLICT (id) DO NOTHING;

-- Seed default email templates
INSERT INTO email_templates (id, name, description, subject_template, html_template, text_template, category_id, available_variables) VALUES
  (
    'welcome_member',
    'Welcome Email (New Member)',
    'Sent when an organization becomes a paying member',
    'Welcome to AgenticAdvertising.org!',
    '<!-- Template managed in code for now -->',
    '<!-- Template managed in code for now -->',
    NULL,  -- Transactional
    '{"organizationName": "Name of the organization", "productName": "Subscription plan name"}'
  ),
  (
    'signup_user',
    'Welcome Email (New User)',
    'Sent when a new user signs up',
    'Welcome to AgenticAdvertising.org',
    '<!-- Template managed in code for now -->',
    '<!-- Template managed in code for now -->',
    NULL,  -- Transactional
    '{"firstName": "User first name", "organizationName": "Organization name", "hasActiveSubscription": "Whether org is a member"}'
  ),
  (
    'newsletter',
    'Monthly Newsletter',
    'Monthly digest of news, updates, and member highlights',
    '{{month}} Newsletter - AgenticAdvertising.org',
    '<!-- Admin editable -->',
    '<!-- Admin editable -->',
    'newsletter',
    '{"month": "Newsletter month (e.g., January 2025)", "articles": "Array of article objects"}'
  )
ON CONFLICT (id) DO NOTHING;

-- Comments
COMMENT ON TABLE email_categories IS 'Categories of emails users can subscribe/unsubscribe from';
COMMENT ON TABLE user_email_preferences IS 'User-level email preferences and unsubscribe tokens';
COMMENT ON TABLE user_email_category_preferences IS 'Per-category preference overrides';
COMMENT ON TABLE email_templates IS 'Admin-editable email templates';
COMMENT ON TABLE email_campaigns IS 'One-off email campaigns like newsletters';
COMMENT ON COLUMN user_email_preferences.unsubscribe_token IS 'Token for one-click unsubscribe without requiring login';
COMMENT ON COLUMN user_email_preferences.global_unsubscribe IS 'If true, user receives no non-transactional emails';
