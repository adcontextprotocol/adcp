-- Harden certification chat retries and experience metrics after the initial
-- reliability rollout. A turn lease makes client_request_id an execution
-- idempotency key, not merely a message-storage dedupe key.
CREATE TABLE IF NOT EXISTS addie_chat_turns (
  thread_id UUID NOT NULL REFERENCES addie_threads(thread_id) ON DELETE CASCADE,
  client_request_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'interrupted', 'completed')),
  lease_id UUID NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_addie_chat_turns_expired_processing
  ON addie_chat_turns(lease_expires_at)
  WHERE status = 'processing';

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_completed_assistant_per_request
  ON addie_thread_messages(thread_id, client_request_id)
  WHERE role = 'assistant'
    AND delivery_status = 'completed'
    AND client_request_id IS NOT NULL;

-- Loading the same checkpoint repeatedly is one resume session, not several
-- successful resumes. COALESCE also deduplicates modules without a checkpoint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cert_resume_once_per_checkpoint
  ON certification_experience_events (
    workos_user_id,
    module_id,
    addie_thread_id,
    COALESCE(metadata->>'checkpoint_saved_at', '')
  )
  WHERE event_type = 'module_resumed';

-- Only one cross-replica call may consume a learner's certification reserve
-- at a time. Normal tier-cap concurrency remains governed by the existing
-- rate limit; this protects the extra last-mile budget specifically.
CREATE TABLE IF NOT EXISTS certification_completion_leases (
  scope_key TEXT PRIMARY KEY,
  lease_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
