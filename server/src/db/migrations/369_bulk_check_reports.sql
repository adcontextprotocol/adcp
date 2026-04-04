-- Bulk property check reports — separate from legacy property_check_reports
-- because the JSONB shape differs (verdict-based vs bucket-based).
-- IF NOT EXISTS: table was created under migration 361, later renumbered to 369.

CREATE TABLE IF NOT EXISTS bulk_check_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX IF NOT EXISTS idx_bulk_check_reports_expires ON bulk_check_reports (expires_at);
