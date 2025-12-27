-- Migration: 037_email_tracking.sql
-- Track email sends, opens, and clicks for engagement analytics

-- Email events table - tracks all email lifecycle events
CREATE TABLE IF NOT EXISTS email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tracking identifier (used in click URLs)
  tracking_id VARCHAR(32) NOT NULL UNIQUE,

  -- Email details
  email_type VARCHAR(50) NOT NULL,  -- welcome_member, signup_user, etc.
  recipient_email VARCHAR(255) NOT NULL,
  subject VARCHAR(500),

  -- User/org context (nullable - some emails may not have org context)
  workos_user_id VARCHAR(255),
  workos_organization_id VARCHAR(255),

  -- Send status
  sent_at TIMESTAMP WITH TIME ZONE,
  resend_email_id VARCHAR(255),  -- Resend's email ID for webhook correlation

  -- Engagement tracking
  opened_at TIMESTAMP WITH TIME ZONE,
  open_count INTEGER DEFAULT 0,

  -- Click tracking (aggregated - details in email_clicks)
  first_clicked_at TIMESTAMP WITH TIME ZONE,
  click_count INTEGER DEFAULT 0,

  -- Delivery status
  delivered_at TIMESTAMP WITH TIME ZONE,
  bounced_at TIMESTAMP WITH TIME ZONE,
  bounce_reason TEXT,

  -- Metadata
  metadata JSONB,  -- Store any additional context (e.g., which email variant)

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Individual click events for detailed analytics
CREATE TABLE IF NOT EXISTS email_clicks (
  id SERIAL PRIMARY KEY,

  -- Link to parent email
  email_event_id UUID NOT NULL REFERENCES email_events(id) ON DELETE CASCADE,

  -- Click details
  link_name VARCHAR(100),  -- e.g., 'cta_dashboard', 'cta_billing', 'footer_link'
  destination_url TEXT NOT NULL,

  -- When and from where
  clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address VARCHAR(50),
  user_agent TEXT,
  referrer TEXT,

  -- UTM parameters captured
  utm_source VARCHAR(100),
  utm_medium VARCHAR(100),
  utm_campaign VARCHAR(100)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_email_events_tracking_id ON email_events(tracking_id);
CREATE INDEX IF NOT EXISTS idx_email_events_user ON email_events(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_email_events_org ON email_events(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(email_type);
CREATE INDEX IF NOT EXISTS idx_email_events_sent ON email_events(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_resend_id ON email_events(resend_email_id);

CREATE INDEX IF NOT EXISTS idx_email_clicks_event ON email_clicks(email_event_id);
CREATE INDEX IF NOT EXISTS idx_email_clicks_time ON email_clicks(clicked_at DESC);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_email_events_updated_at ON email_events;
CREATE TRIGGER update_email_events_updated_at
  BEFORE UPDATE ON email_events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE email_events IS 'Tracks all transactional email sends and engagement';
COMMENT ON TABLE email_clicks IS 'Individual click events for email link tracking';
COMMENT ON COLUMN email_events.tracking_id IS 'Short ID used in tracked URLs (e.g., /r/abc123)';
COMMENT ON COLUMN email_events.email_type IS 'Type: welcome_member, signup_user, etc.';
COMMENT ON COLUMN email_clicks.link_name IS 'Semantic name for the link (cta_dashboard, cta_billing, etc.)';
