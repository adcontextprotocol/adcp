-- Append-only audit history for AgenticAdvertising.org site-admin grants and revocations.
-- This intentionally has no foreign keys: a later account or membership deletion
-- must not erase the forensic record of elevated access.

CREATE TABLE IF NOT EXISTS aao_admin_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'revoked')),
  actor_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  mechanism TEXT NOT NULL CHECK (mechanism = 'aao_admin_working_group'),
  actor_authorization_mechanism TEXT NOT NULL CHECK (actor_authorization_mechanism IN (
    'aao_admin_working_group',
    'break_glass_admin_email',
    'static_admin_api_key',
    'development'
  )),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aao_admin_access_events_target_created
  ON aao_admin_access_events(target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aao_admin_access_events_actor_created
  ON aao_admin_access_events(actor_user_id, created_at DESC);

COMMENT ON TABLE aao_admin_access_events IS
  'Append-only forensic history for site-admin membership grants and revocations.';
