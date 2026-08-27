-- Bind account-link completion notifications to the conversation that
-- initiated them. Tokens are stored only as hashes and are short-lived.

CREATE TABLE addie_account_link_correlations (
  correlation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash CHAR(64) NOT NULL UNIQUE,
  surface VARCHAR(20) NOT NULL CHECK (surface IN ('slack', 'web')),
  thread_id UUID NOT NULL REFERENCES addie_threads(thread_id) ON DELETE CASCADE,
  initiating_user_id VARCHAR(255) NOT NULL,
  external_id VARCHAR(500) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addie_account_link_correlations_expiry
  ON addie_account_link_correlations(expires_at);

CREATE TABLE addie_proactive_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,
  correlation_id UUID REFERENCES addie_account_link_correlations(correlation_id) ON DELETE SET NULL,
  surface VARCHAR(20) NOT NULL CHECK (surface IN ('slack', 'web')),
  thread_id UUID REFERENCES addie_threads(thread_id) ON DELETE SET NULL,
  initiating_user_id VARCHAR(255),
  delivery_status VARCHAR(20) NOT NULL CHECK (delivery_status IN ('delivered', 'skipped', 'failed')),
  reason_code VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addie_proactive_events_thread
  ON addie_proactive_events(thread_id, created_at DESC);

CREATE INDEX idx_addie_proactive_events_type_status
  ON addie_proactive_events(event_type, delivery_status, created_at DESC);

COMMENT ON TABLE addie_account_link_correlations IS
  'Short-lived, single-use account-link notification origins; raw bearer tokens are never stored.';
COMMENT ON TABLE addie_proactive_events IS
  'Explicit audit events for proactive Addie delivery outcomes; contains identifiers and reason codes, never message content.';
