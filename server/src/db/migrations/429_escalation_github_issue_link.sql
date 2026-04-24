-- Migration: link escalations to GitHub issues
--
-- When a triage suggestion resolves an escalation by filing a GitHub
-- issue, we record the resulting issue on the escalation so:
--   - admins can click through from the dashboard,
--   - later triage runs skip items already linked to an issue,
--   - resolution notes carry a durable reference.
--
-- Also extends escalation_triage_suggestions with a proposed-issue
-- draft so the admin UI can show what will be filed before the admin
-- clicks accept, and widens the suggested_status enum to include the
-- file-as-issue action.

ALTER TABLE addie_escalations
  ADD COLUMN IF NOT EXISTS github_issue_url TEXT,
  ADD COLUMN IF NOT EXISTS github_issue_number INT,
  ADD COLUMN IF NOT EXISTS github_issue_repo TEXT;

COMMENT ON COLUMN addie_escalations.github_issue_url IS
  'Set when a triage suggestion filed a GitHub issue for this escalation.';

ALTER TABLE escalation_triage_suggestions
  ADD COLUMN IF NOT EXISTS proposed_github_issue JSONB;

COMMENT ON COLUMN escalation_triage_suggestions.proposed_github_issue IS
  'Draft { title, body, repo, labels } shown to admins for file_as_issue suggestions.';

-- Widen the suggested_status check constraint. The existing check is a
-- named constraint from migration 428; drop and recreate.
ALTER TABLE escalation_triage_suggestions
  DROP CONSTRAINT IF EXISTS escalation_triage_suggestions_status_chk;

ALTER TABLE escalation_triage_suggestions
  ADD CONSTRAINT escalation_triage_suggestions_status_chk
    CHECK (suggested_status IN ('resolved', 'wont_do', 'keep_open', 'file_as_issue'));
