-- Migration: 084_events.sql
-- Events system for AAO: events, registrations, and sponsorships
-- Supports both in-person (Luma-managed) and virtual events

-- =====================================================
-- EVENTS TABLE
-- =====================================================
-- Main events table for meetups, summits, webinars, etc.

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- URL-friendly identifier
  slug VARCHAR(255) UNIQUE NOT NULL,

  -- Event details
  title VARCHAR(500) NOT NULL,
  description TEXT,
  short_description VARCHAR(500),  -- For cards/listings

  -- Event type: summit, meetup, webinar, workshop, etc.
  event_type VARCHAR(50) NOT NULL DEFAULT 'meetup'
    CHECK (event_type IN ('summit', 'meetup', 'webinar', 'workshop', 'conference', 'other')),

  -- Event format: in_person, virtual, hybrid
  event_format VARCHAR(50) NOT NULL DEFAULT 'in_person'
    CHECK (event_format IN ('in_person', 'virtual', 'hybrid')),

  -- Timing
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE,
  timezone VARCHAR(100) DEFAULT 'America/New_York',

  -- Location (for in-person/hybrid)
  venue_name VARCHAR(255),
  venue_address TEXT,
  venue_city VARCHAR(100),
  venue_state VARCHAR(100),
  venue_country VARCHAR(100),
  venue_lat DECIMAL(10, 8),
  venue_lng DECIMAL(11, 8),

  -- Virtual event details
  virtual_url TEXT,  -- Zoom/Meet link (hidden until registered)
  virtual_platform VARCHAR(100),  -- 'zoom', 'google_meet', 'youtube_live', etc.

  -- External integrations
  luma_event_id VARCHAR(255),  -- Luma event ID if managed there
  luma_url TEXT,  -- Public Luma registration URL

  -- Featured image
  featured_image_url TEXT,

  -- Sponsorship settings
  sponsorship_enabled BOOLEAN DEFAULT FALSE,
  sponsorship_tiers JSONB DEFAULT '[]',  -- Array of {tier_id, name, price_cents, benefits, max_sponsors}
  stripe_product_id VARCHAR(255),  -- Stripe product ID for sponsorships (if set, enables checkout)

  -- Publishing
  status VARCHAR(50) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'cancelled', 'completed')),
  published_at TIMESTAMP WITH TIME ZONE,

  -- Capacity
  max_attendees INTEGER,

  -- Ownership/permissions
  created_by_user_id VARCHAR(255),  -- WorkOS user ID of creator
  organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,

  -- Flexible metadata
  metadata JSONB NOT NULL DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for events
CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_event_format ON events(event_format);
CREATE INDEX IF NOT EXISTS idx_events_luma_event_id ON events(luma_event_id);
CREATE INDEX IF NOT EXISTS idx_events_published ON events(status, start_time)
  WHERE status = 'published';

-- Trigger for updated_at
CREATE TRIGGER update_events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE events IS 'Events (summits, meetups, webinars) managed by AAO';
COMMENT ON COLUMN events.slug IS 'URL-friendly identifier for /events/{slug}';
COMMENT ON COLUMN events.event_type IS 'Type: summit, meetup, webinar, workshop, conference, other';
COMMENT ON COLUMN events.event_format IS 'Format: in_person, virtual, hybrid';
COMMENT ON COLUMN events.luma_event_id IS 'Luma event ID if registration is managed through Luma';
COMMENT ON COLUMN events.sponsorship_tiers IS 'JSON array of sponsorship options: [{tier_id, name, price_cents, benefits[], max_sponsors}]';

-- =====================================================
-- EVENT REGISTRATIONS TABLE
-- =====================================================
-- Links contacts/users to events, tracks attendance

CREATE TABLE IF NOT EXISTS event_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event reference
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Contact reference (one of these should be set)
  -- For AAO members with accounts
  workos_user_id VARCHAR(255),
  -- For contacts without accounts (via email)
  email_contact_id UUID REFERENCES email_contacts(id) ON DELETE SET NULL,
  -- Fallback: just store email directly
  email VARCHAR(255),
  name VARCHAR(255),

  -- Registration details
  registration_status VARCHAR(50) NOT NULL DEFAULT 'registered'
    CHECK (registration_status IN ('registered', 'waitlisted', 'cancelled', 'no_show')),

  -- Attendance tracking
  attended BOOLEAN DEFAULT FALSE,
  checked_in_at TIMESTAMP WITH TIME ZONE,

  -- External registration info
  luma_guest_id VARCHAR(255),  -- Luma guest ID if registered via Luma
  registration_source VARCHAR(50) DEFAULT 'direct'
    CHECK (registration_source IN ('direct', 'luma', 'import', 'admin')),

  -- Organization (for corporate registrations)
  organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,

  -- Ticket/pass info
  ticket_type VARCHAR(100),  -- 'general', 'vip', 'speaker', 'sponsor', etc.
  ticket_code VARCHAR(100),  -- Unique code for check-in

  -- Additional info collected at registration
  registration_data JSONB DEFAULT '{}',

  -- Timestamps
  registered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Unique constraints
  CONSTRAINT unique_event_user UNIQUE (event_id, workos_user_id),
  CONSTRAINT unique_event_email_contact UNIQUE (event_id, email_contact_id),
  CONSTRAINT unique_event_email UNIQUE (event_id, email) WHERE workos_user_id IS NULL AND email_contact_id IS NULL
);

-- Indexes for registrations
CREATE INDEX IF NOT EXISTS idx_event_registrations_event ON event_registrations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_registrations_user ON event_registrations(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_event_registrations_email_contact ON event_registrations(email_contact_id);
CREATE INDEX IF NOT EXISTS idx_event_registrations_email ON event_registrations(email);
CREATE INDEX IF NOT EXISTS idx_event_registrations_status ON event_registrations(registration_status);
CREATE INDEX IF NOT EXISTS idx_event_registrations_luma ON event_registrations(luma_guest_id);
CREATE INDEX IF NOT EXISTS idx_event_registrations_attended ON event_registrations(event_id, attended)
  WHERE attended = TRUE;

-- Trigger for updated_at
CREATE TRIGGER update_event_registrations_updated_at
  BEFORE UPDATE ON event_registrations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE event_registrations IS 'Event registrations linking contacts/users to events';
COMMENT ON COLUMN event_registrations.workos_user_id IS 'WorkOS user ID for AAO members';
COMMENT ON COLUMN event_registrations.email_contact_id IS 'Reference to email_contacts for non-member registrations';
COMMENT ON COLUMN event_registrations.attended IS 'Whether the registrant actually attended';
COMMENT ON COLUMN event_registrations.luma_guest_id IS 'Luma guest ID if synced from Luma';
COMMENT ON COLUMN event_registrations.ticket_type IS 'Type of ticket: general, vip, speaker, sponsor';

-- =====================================================
-- EVENT SPONSORSHIPS TABLE
-- =====================================================
-- Tracks sponsorships for events, linked to Stripe payments

CREATE TABLE IF NOT EXISTS event_sponsorships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event reference
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Sponsor organization
  organization_id VARCHAR(255) NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- Contact who purchased
  purchased_by_user_id VARCHAR(255),

  -- Sponsorship tier (references tier_id in events.sponsorship_tiers)
  tier_id VARCHAR(100) NOT NULL,
  tier_name VARCHAR(255),

  -- Pricing
  amount_cents INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',

  -- Payment status
  payment_status VARCHAR(50) NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'refunded', 'cancelled')),

  -- Stripe references
  stripe_checkout_session_id VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  stripe_invoice_id VARCHAR(255),

  -- Benefits delivered
  benefits_delivered JSONB DEFAULT '{}',  -- Track which benefits have been fulfilled

  -- Display settings
  display_order INTEGER DEFAULT 0,  -- Lower = higher on page
  show_logo BOOLEAN DEFAULT TRUE,
  logo_url TEXT,

  -- Notes
  notes TEXT,

  -- Timestamps
  paid_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for sponsorships
CREATE INDEX IF NOT EXISTS idx_event_sponsorships_event ON event_sponsorships(event_id);
CREATE INDEX IF NOT EXISTS idx_event_sponsorships_org ON event_sponsorships(organization_id);
CREATE INDEX IF NOT EXISTS idx_event_sponsorships_status ON event_sponsorships(payment_status);
CREATE INDEX IF NOT EXISTS idx_event_sponsorships_stripe_session ON event_sponsorships(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_event_sponsorships_paid ON event_sponsorships(event_id, payment_status)
  WHERE payment_status = 'paid';

-- Unique constraint: one org can only have one sponsorship per tier per event
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_sponsorships_unique_tier
  ON event_sponsorships(event_id, organization_id, tier_id)
  WHERE payment_status != 'cancelled' AND payment_status != 'refunded';

-- Trigger for updated_at
CREATE TRIGGER update_event_sponsorships_updated_at
  BEFORE UPDATE ON event_sponsorships
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE event_sponsorships IS 'Event sponsorships with Stripe payment tracking';
COMMENT ON COLUMN event_sponsorships.tier_id IS 'References tier_id in events.sponsorship_tiers JSONB';
COMMENT ON COLUMN event_sponsorships.amount_cents IS 'Amount in smallest currency unit (cents for USD)';
COMMENT ON COLUMN event_sponsorships.benefits_delivered IS 'Track fulfillment: {logo_displayed: true, booth_assigned: "A5", ...}';

-- =====================================================
-- VIEWS FOR CONVENIENT QUERYING
-- =====================================================

-- Upcoming published events with registration counts
CREATE OR REPLACE VIEW upcoming_events AS
SELECT
  e.*,
  (SELECT COUNT(*) FROM event_registrations er
   WHERE er.event_id = e.id AND er.registration_status = 'registered') as registration_count,
  (SELECT COUNT(*) FROM event_registrations er
   WHERE er.event_id = e.id AND er.attended = TRUE) as attendance_count,
  (SELECT COUNT(*) FROM event_sponsorships es
   WHERE es.event_id = e.id AND es.payment_status = 'paid') as sponsor_count,
  (SELECT COALESCE(SUM(es.amount_cents), 0) FROM event_sponsorships es
   WHERE es.event_id = e.id AND es.payment_status = 'paid') as sponsorship_revenue_cents
FROM events e
WHERE e.status = 'published'
  AND e.start_time > NOW()
ORDER BY e.start_time ASC;

COMMENT ON VIEW upcoming_events IS 'Published events in the future with registration and sponsorship counts';

-- Contact event history (for unified_contacts enrichment)
CREATE OR REPLACE VIEW contact_event_history AS
SELECT
  er.workos_user_id,
  er.email_contact_id,
  er.email,
  COUNT(*) as total_registrations,
  COUNT(*) FILTER (WHERE er.attended = TRUE) as total_attended,
  MAX(e.start_time) as last_event_date,
  ARRAY_AGG(DISTINCT e.event_type) as event_types_attended,
  ARRAY_AGG(DISTINCT e.id ORDER BY e.start_time DESC) as event_ids
FROM event_registrations er
JOIN events e ON e.id = er.event_id
WHERE er.registration_status = 'registered'
GROUP BY er.workos_user_id, er.email_contact_id, er.email;

COMMENT ON VIEW contact_event_history IS 'Event attendance history per contact for engagement scoring';

-- Event sponsors view (for public display)
CREATE OR REPLACE VIEW event_sponsors AS
SELECT
  es.event_id,
  es.tier_id,
  es.tier_name,
  es.display_order,
  es.logo_url,
  o.workos_organization_id as organization_id,
  o.name as organization_name,
  COALESCE(mp.logo_url, es.logo_url) as display_logo_url,
  mp.website_url as organization_website
FROM event_sponsorships es
JOIN organizations o ON o.workos_organization_id = es.organization_id
LEFT JOIN member_profiles mp ON mp.organization_id = o.workos_organization_id
WHERE es.payment_status = 'paid'
  AND es.show_logo = TRUE
ORDER BY es.display_order ASC, es.paid_at ASC;

COMMENT ON VIEW event_sponsors IS 'Paid sponsors for events, for public display';
