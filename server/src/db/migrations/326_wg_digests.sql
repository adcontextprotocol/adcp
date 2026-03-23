-- Working group biweekly digest tracking
CREATE TABLE IF NOT EXISTS wg_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
  edition_date DATE NOT NULL,
  content JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped')),
  sent_at TIMESTAMPTZ,
  recipient_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(working_group_id, edition_date)
);

CREATE INDEX IF NOT EXISTS idx_wg_digests_edition_date ON wg_digests(edition_date);
CREATE INDEX IF NOT EXISTS idx_wg_digests_status ON wg_digests(status);
