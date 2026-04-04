-- Bulk property check reports — separate from legacy property_check_reports
-- because the JSONB shape differs (verdict-based vs bucket-based).

CREATE TABLE bulk_check_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX idx_bulk_check_reports_expires ON bulk_check_reports (expires_at);
