-- Migration: add perspective link to escalations
--
-- When Addie files an escalation about a draft (e.g. "Mary wants to publish
-- this post but something's stuck"), she can now attach the resulting
-- perspective id. Approving the content auto-resolves the linked escalation,
-- so the queue stays clean and reviewers don't have to manually chase
-- "the escalation is about the post I just approved" cleanup.
--
-- Part of #2702 (editorial epic #2693).

ALTER TABLE addie_escalations
  ADD COLUMN IF NOT EXISTS perspective_id UUID REFERENCES perspectives(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS perspective_slug TEXT;

-- Index for the auto-close query (approve perspective -> resolve linked open escalations).
-- Partial index: only open escalations with a link, which is the hot-path we care about.
CREATE INDEX IF NOT EXISTS idx_addie_escalations_open_perspective_id
  ON addie_escalations(perspective_id)
  WHERE perspective_id IS NOT NULL AND status = 'open';

COMMENT ON COLUMN addie_escalations.perspective_id IS
  'Optional: the perspective this escalation is about. Approving that perspective auto-resolves this escalation.';
COMMENT ON COLUMN addie_escalations.perspective_slug IS
  'Optional: denormalized slug so admin dashboards can link without a join.';
