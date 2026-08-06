-- Certification experience reliability and outcome tracking.
--
-- client_request_id makes web-chat retries safe for the learner: the original
-- user turn is stored once, while assistant attempts can be retained as an
-- interrupted audit trail and followed by a completed retry.
ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS client_request_id UUID,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE addie_thread_messages
  DROP CONSTRAINT IF EXISTS addie_thread_messages_delivery_status_check;

ALTER TABLE addie_thread_messages
  ADD CONSTRAINT addie_thread_messages_delivery_status_check
  CHECK (delivery_status IN ('completed', 'interrupted'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_addie_thread_user_client_request
  ON addie_thread_messages(thread_id, client_request_id)
  WHERE role = 'user' AND client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_addie_thread_assistant_client_request
  ON addie_thread_messages(thread_id, client_request_id, created_at DESC)
  WHERE role = 'assistant' AND client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS certification_experience_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL,
  module_id TEXT REFERENCES certification_modules(id) ON DELETE SET NULL,
  addie_thread_id TEXT,
  event_type TEXT NOT NULL,
  client_request_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cert_experience_event_request_once
  ON certification_experience_events(workos_user_id, event_type, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cert_experience_event_type_created
  ON certification_experience_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cert_experience_user_created
  ON certification_experience_events(workos_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS certification_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL,
  module_id TEXT REFERENCES certification_modules(id) ON DELETE SET NULL,
  repository TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'drafted'
    CHECK (status IN ('drafted', 'submitted')),
  draft_url TEXT,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workos_user_id, repository, title)
);

CREATE INDEX IF NOT EXISTS idx_cert_contributions_user_updated
  ON certification_contributions(workos_user_id, updated_at DESC);

-- The provider ID tells us issuance succeeded, but historically we did not
-- preserve when it succeeded. Keep that timestamp so credential latency is a
-- real operational metric rather than an inference from a chat response.
ALTER TABLE user_credentials
  ADD COLUMN IF NOT EXISTS certifier_issued_at TIMESTAMPTZ;

UPDATE user_credentials
SET certifier_issued_at = awarded_at
WHERE certifier_public_id IS NOT NULL
  AND certifier_issued_at IS NULL;
