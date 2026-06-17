-- Public, requester-visible updates for Addie escalations.
-- Internal triage context remains on addie_escalations.addie_context and is not exposed.

CREATE TABLE IF NOT EXISTS addie_escalation_updates (
  id SERIAL PRIMARY KEY,
  escalation_id INT NOT NULL REFERENCES addie_escalations(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('requester', 'admin', 'system')),
  author_user_id TEXT,
  body TEXT NOT NULL,
  visible_to_requester BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT requester_updates_are_public
    CHECK (author_type <> 'requester' OR visible_to_requester = TRUE)
);

CREATE INDEX IF NOT EXISTS idx_addie_escalation_updates_escalation
  ON addie_escalation_updates(escalation_id, created_at ASC);

ALTER TABLE addie_escalation_updates
  ALTER COLUMN visible_to_requester SET DEFAULT FALSE;

DO $$
BEGIN
  ALTER TABLE addie_escalation_updates
    ADD CONSTRAINT requester_updates_are_public
      CHECK (author_type <> 'requester' OR visible_to_requester = TRUE);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
