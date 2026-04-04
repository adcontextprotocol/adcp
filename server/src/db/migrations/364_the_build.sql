-- The Build: Sage's biweekly contributor briefing
-- Parallel to weekly_digests (The Prompt) but separate table for type safety

CREATE TABLE build_editions (
  id SERIAL PRIMARY KEY,
  edition_date DATE NOT NULL UNIQUE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sent', 'skipped')),
  perspective_id UUID REFERENCES perspectives(id),
  review_channel_id TEXT,
  review_message_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  send_stats JSONB,
  approved_by TEXT,
  approved_at TIMESTAMPTZ
);

CREATE INDEX idx_build_editions_status ON build_editions(status);
CREATE INDEX idx_build_editions_date ON build_editions(edition_date DESC);

-- Email category for opt-out (default off — contributor seats auto-receive)
INSERT INTO email_categories (id, name, description, default_enabled, sort_order)
VALUES ('the_build', 'The Build', 'Sage''s biweekly contributor briefing — WG decisions, releases, and help needed', false, 30)
ON CONFLICT (id) DO NOTHING;
