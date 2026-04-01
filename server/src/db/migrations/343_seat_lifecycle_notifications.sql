-- Seat lifecycle notification tracking
-- Stores the last warning threshold sent per seat type to prevent duplicate notifications.
-- Uses hysteresis: 80% re-arms at 60%, not at 80%.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS last_contributor_seat_warning INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_community_seat_warning INT DEFAULT 0;

-- Seat upgrade requests from community_only members wanting contributor access
CREATE TABLE IF NOT EXISTS seat_upgrade_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_organization_id TEXT NOT NULL,
  workos_user_id TEXT NOT NULL,
  requested_seat_type TEXT NOT NULL DEFAULT 'contributor',
  resource_type TEXT NOT NULL CHECK (resource_type IN ('working_group', 'council', 'product_summit')),
  resource_id TEXT,
  resource_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  admin_reminder_sent_at TIMESTAMPTZ,
  member_timeout_notified_at TIMESTAMPTZ
);

-- Only one pending request per user per resource
CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_upgrade_requests_pending
  ON seat_upgrade_requests(workos_organization_id, workos_user_id, resource_type, COALESCE(resource_id, ''))
  WHERE (status = 'pending');

-- Fast lookup of pending requests by org
CREATE INDEX IF NOT EXISTS idx_seat_upgrade_requests_org_pending
  ON seat_upgrade_requests(workos_organization_id)
  WHERE (status = 'pending');

-- For reminder cron: find stale pending requests
CREATE INDEX IF NOT EXISTS idx_seat_upgrade_requests_stale
  ON seat_upgrade_requests(created_at)
  WHERE (status = 'pending');
