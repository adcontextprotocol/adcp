-- Allocation audited 2026-09-13T14:10:20.867136+00:00 against main 1834f1c5d29d56fdf4bed521184d8b595dd0accd.
-- All 29 open PRs / 2783 changed files were fully paginated; heads were rechecked.
-- 588-591 belong to other slices; 591 exclusively PR1c (#7457).
-- Current-main and remaining live-PR allocations are recorded in the PR body.
-- 592 creates only its own journal and indexes. No schema/merge-order dependency
-- on those migrations. Exact live-ledger heads and checksum are in the PR body.
-- Durable provider/local mutation intent. No user FK: retain audit evidence if
-- the credential is subsequently deleted. This table never grants authority.
CREATE TABLE email_mutations (
  id UUID PRIMARY KEY,
  workos_user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  old_email TEXT NOT NULL,
  old_email_verified BOOLEAN NOT NULL,
  new_email TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'compensated', 'reconciliation_required')),
  failure_code TEXT,
  reconciliation_attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX email_mutations_one_unresolved_credential
  ON email_mutations (workos_user_id)
  WHERE state IN ('pending', 'reconciliation_required');

CREATE INDEX email_mutations_credential_history
  ON email_mutations (workos_user_id, created_at DESC);
