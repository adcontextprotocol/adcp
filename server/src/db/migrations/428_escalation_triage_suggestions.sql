-- Migration: escalation triage suggestions
--
-- Addie scans open escalations on a schedule and writes suggested
-- status transitions here instead of mutating the escalation directly.
-- An admin reviews the suggestion (accept or reject) and the accept
-- path runs the normal PATCH flow. This keeps automation auditable and
-- reversible — every close has an operator behind it.

CREATE TABLE IF NOT EXISTS escalation_triage_suggestions (
  id SERIAL PRIMARY KEY,
  escalation_id INT NOT NULL REFERENCES addie_escalations(id) ON DELETE CASCADE,
  suggested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suggested_status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  bucket TEXT,
  reasoning TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  decision TEXT,
  decision_notes TEXT,
  CONSTRAINT escalation_triage_suggestions_status_chk
    CHECK (suggested_status IN ('resolved', 'wont_do', 'keep_open')),
  CONSTRAINT escalation_triage_suggestions_confidence_chk
    CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT escalation_triage_suggestions_decision_chk
    CHECK (decision IS NULL OR decision IN ('accepted', 'rejected', 'superseded'))
);

-- One open suggestion per escalation. When a suggestion is reviewed
-- (decision IS NOT NULL) the runner can write a fresh one on the next
-- pass if the situation changes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_etr_pending_per_escalation
  ON escalation_triage_suggestions(escalation_id)
  WHERE decision IS NULL;

CREATE INDEX IF NOT EXISTS idx_etr_pending
  ON escalation_triage_suggestions(suggested_at DESC)
  WHERE decision IS NULL;

COMMENT ON TABLE escalation_triage_suggestions IS
  'Auto-generated suggestions for open escalation resolution. Admins review and accept/reject.';
COMMENT ON COLUMN escalation_triage_suggestions.evidence IS
  'Array of evidence strings (URL probes, git commit refs, related escalation ids, etc).';
COMMENT ON COLUMN escalation_triage_suggestions.bucket IS
  'Heuristic bucket (bug, billing, invite, content, ops-other, addie) for filtering and batch review.';
