-- Migration: 049_email_contacts.sql
-- Email contact tracking for AAO member/prospect discovery
-- Mirrors slack_user_mappings pattern: track contacts seen via email, link to WorkOS when matched

-- Email Contacts Table
CREATE TABLE IF NOT EXISTS email_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Email contact info
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255),  -- Extracted from "Name <email>" format
  domain VARCHAR(255),        -- Extracted domain for prospect discovery

  -- AAO/WorkOS mapping (NULL if not linked)
  workos_user_id VARCHAR(255),
  organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,

  -- Status: mapped, unmapped
  mapping_status VARCHAR(50) NOT NULL DEFAULT 'unmapped'
    CHECK (mapping_status IN ('mapped', 'unmapped')),

  -- How mapped: email_auto (matched existing user), manual_admin
  mapping_source VARCHAR(50)
    CHECK (mapping_source IN ('email_auto', 'manual_admin')),

  -- Activity tracking
  first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  email_count INTEGER DEFAULT 1,

  -- Timestamps
  mapped_at TIMESTAMP WITH TIME ZONE,
  mapped_by_user_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_contacts_workos_user ON email_contacts(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_email_contacts_org ON email_contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_email_contacts_domain ON email_contacts(domain);
CREATE INDEX IF NOT EXISTS idx_email_contacts_status ON email_contacts(mapping_status);
CREATE INDEX IF NOT EXISTS idx_email_contacts_unmapped_active
  ON email_contacts(mapping_status, domain, email_count DESC)
  WHERE mapping_status = 'unmapped';

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_email_contacts_updated_at ON email_contacts;
CREATE TRIGGER update_email_contacts_updated_at
  BEFORE UPDATE ON email_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE email_contacts IS 'Tracks email contacts seen via inbound emails, similar to slack_user_mappings';
COMMENT ON COLUMN email_contacts.workos_user_id IS 'WorkOS user ID if linked, NULL if unmapped';
COMMENT ON COLUMN email_contacts.organization_id IS 'Organization ID if linked, NULL if unmapped';
COMMENT ON COLUMN email_contacts.domain IS 'Email domain for prospect discovery (e.g., "acme.com")';
COMMENT ON COLUMN email_contacts.mapping_status IS 'mapped = linked to AAO account, unmapped = no link';
COMMENT ON COLUMN email_contacts.email_count IS 'Number of emails seen from/to this contact';

-- Email contact activities table (stores email insights per contact)
CREATE TABLE IF NOT EXISTS email_contact_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  email_contact_id UUID NOT NULL REFERENCES email_contacts(id) ON DELETE CASCADE,

  -- Email metadata
  email_id VARCHAR(255),        -- Resend email ID
  message_id VARCHAR(255),      -- Email Message-ID header for dedup
  subject VARCHAR(500),
  direction VARCHAR(20) NOT NULL CHECK (direction IN ('inbound', 'outbound')),

  -- Extracted insights
  insights TEXT,
  insight_method VARCHAR(20),   -- 'claude' or 'simple'
  tokens_used INTEGER,

  -- Full metadata
  metadata JSONB,

  -- Timestamps
  email_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_contact_activities_contact ON email_contact_activities(email_contact_id);
CREATE INDEX IF NOT EXISTS idx_email_contact_activities_message_id ON email_contact_activities(message_id);
CREATE INDEX IF NOT EXISTS idx_email_contact_activities_date ON email_contact_activities(email_date DESC);

COMMENT ON TABLE email_contact_activities IS 'Email activity log per contact, stores insights from inbound emails';
COMMENT ON COLUMN email_contact_activities.direction IS 'inbound = received by us, outbound = sent by us';
COMMENT ON COLUMN email_contact_activities.insights IS 'AI-extracted insights from email content';
