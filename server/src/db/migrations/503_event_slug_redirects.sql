-- Track event slug migrations so old /events/{slug} links keep resolving.
CREATE TABLE IF NOT EXISTS event_slug_redirects (
  old_slug VARCHAR(255) PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_slug_redirects_event
  ON event_slug_redirects(event_id);

COMMENT ON TABLE event_slug_redirects IS 'Redirects old event slugs to the canonical event after event date/title slug changes';
COMMENT ON COLUMN event_slug_redirects.old_slug IS 'Previously valid event slug';
COMMENT ON COLUMN event_slug_redirects.event_id IS 'Canonical event row currently serving the old slug';
