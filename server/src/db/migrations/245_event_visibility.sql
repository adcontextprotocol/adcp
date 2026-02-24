-- Add visibility control to events
-- visibility 'public'          = anyone sees and registers (existing behavior)
-- visibility 'invite_listed'   = shown in listings with invite badge; registration gated
-- visibility 'invite_unlisted' = hidden from all public listings; 404 for non-invited users
ALTER TABLE events
  ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'invite_listed', 'invite_unlisted'));

-- JSON rules for rule-based access on invite-only events
-- Shape: { "membership_required": boolean, "organizations": ["workos_org_id"] }
ALTER TABLE events
  ADD COLUMN access_rules JSONB NOT NULL DEFAULT '{}';

-- Explicit per-email invite list for invite-only events
-- email is stored as lowercase (enforced by CHECK) so unique constraint is case-insensitive
CREATE TABLE event_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = LOWER(email)),
  invited_by_user_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_invites_unique_email UNIQUE (event_id, email)
);

CREATE INDEX idx_event_invites_event_id ON event_invites(event_id);
CREATE INDEX idx_event_invites_email ON event_invites(LOWER(email));

-- Add 'interested' registration status, distinct from 'waitlisted'
-- 'waitlisted' = eligible user, event is full (real queue with expectation of getting in)
-- 'interested' = user expressed interest but is not invited/eligible (no implied commitment)
ALTER TABLE event_registrations
  DROP CONSTRAINT IF EXISTS event_registrations_registration_status_check;
ALTER TABLE event_registrations
  ADD CONSTRAINT event_registrations_registration_status_check
    CHECK (registration_status IN ('registered', 'waitlisted', 'interested', 'cancelled', 'no_show'));

-- Rebuild upcoming_events view to exclude invite_unlisted events from public-facing queries
DROP VIEW IF EXISTS upcoming_events;
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
  AND e.visibility != 'invite_unlisted'
ORDER BY e.start_time ASC;

COMMENT ON VIEW upcoming_events IS 'Published events in the future with registration and sponsorship counts (excludes invite_unlisted events)';
COMMENT ON COLUMN events.visibility IS 'public = open to all; invite_listed = shown in listings but registration gated; invite_unlisted = hidden from public listing';
COMMENT ON COLUMN events.access_rules IS 'Rule-based access criteria: { "membership_required": boolean, "organizations": ["org_id"] }';
COMMENT ON TABLE event_invites IS 'Explicit email invite list for invite-only events';
