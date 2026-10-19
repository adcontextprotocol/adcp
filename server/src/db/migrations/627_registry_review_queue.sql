-- Durable queue of registry submissions that are waiting on a human
-- (adcp#8338).
--
-- Since #8337 the automated registry review fails safe: an unparseable
-- verdict, an out-of-contract verdict, a failed or unconfigured model call
-- (an Anthropic outage, or a deployment with no ANTHROPIC_API_KEY) all
-- resolve to `needs_human_review`, which approves nothing and reverts
-- nothing. That is the right posture, but the only record of it was a line
-- in the moderator Slack channel — so an outage could quietly build a
-- backlog of pending records that nobody could see or work through.
--
-- This table is that record. One open row per outstanding decision:
--
--   * `new_record` — the record is sitting at review_status = 'pending'
--     and is invisible to the registry until a moderator approves it.
--   * `edit`       — the edit is live and `revision_number` is the
--     revision that restores the pre-edit state. #8337 fixed those
--     semantics: undoing edit N means restoring revision N, not N-1.
--     Store the number the reviewer formed its verdict over so the
--     moderator's revert can never drift from it.
--
-- The authoritative pending state still lives on `brands.review_status` /
-- `hosted_properties.review_status`; the admin queue reads those and uses
-- this table for the verdict, reason and age. A record that went pending
-- without any review row (the review never ran at all) therefore still
-- shows up in the queue rather than disappearing from it.
CREATE TABLE IF NOT EXISTS registry_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_type TEXT NOT NULL CHECK (entity_type IN ('brand', 'property')),
  domain TEXT NOT NULL,
  submission_kind TEXT NOT NULL CHECK (submission_kind IN ('new_record', 'edit')),

  -- For an edit: the revision that restores the pre-edit state (#8337).
  revision_number INTEGER,

  -- The member whose submission this is. A `malicious` verdict can only
  -- ever act on this principal (registry-review.ts invariant 1).
  submitter_user_id VARCHAR(255) NOT NULL,
  submitter_email VARCHAR(255),
  edit_summary TEXT,

  -- What the automated review concluded, and what it did about it.
  verdict TEXT NOT NULL
    CHECK (verdict IN ('ok', 'suspicious', 'malicious', 'needs_human_review')),
  reason TEXT,
  action_taken TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Moderator decision. Identity is required whenever the row is resolved.
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('approved', 'rejected', 'reverted')),
  resolved_by_user_id VARCHAR(255),
  resolved_by_email VARCHAR(255),
  resolution_note TEXT,

  CONSTRAINT registry_review_queue_resolution_identity CHECK (
    (resolved_at IS NULL AND resolution IS NULL AND resolved_by_user_id IS NULL)
    OR (resolved_at IS NOT NULL AND resolution IS NOT NULL AND resolved_by_user_id IS NOT NULL)
  ),
  -- An edit item is only actionable if we know which revision to restore.
  CONSTRAINT registry_review_queue_edit_revision CHECK (
    submission_kind <> 'edit' OR revision_number >= 1
  )
);

-- One open item per outstanding decision. A re-review of the same
-- submission updates the existing row instead of stacking duplicates, so
-- the queue's age column keeps measuring how long the member has waited.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_review_queue_open_subject
  ON registry_review_queue (entity_type, domain, submission_kind, COALESCE(revision_number, 0))
  WHERE resolved_at IS NULL;

-- Backlog signal: count and oldest age of the open items.
CREATE INDEX IF NOT EXISTS idx_registry_review_queue_open_age
  ON registry_review_queue (created_at)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_registry_review_queue_record
  ON registry_review_queue (entity_type, domain);

COMMENT ON TABLE registry_review_queue IS
  'Registry submissions waiting on a moderator because the automated review failed safe (adcp#8337, #8338). Open rows are the queue; resolved rows record which moderator decided and how.';
COMMENT ON COLUMN registry_review_queue.revision_number IS
  'For submission_kind = edit: the revision that restores the pre-edit state. Undoing edit N restores revision N (adcp#8337).';
COMMENT ON COLUMN registry_review_queue.reason IS
  'Model-authored, submitter-influenced free text. Sanitize before rendering to Slack or HTML.';
