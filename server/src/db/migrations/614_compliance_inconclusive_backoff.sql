-- Repeated inconclusive target selection should not consume the same heartbeat
-- capacity as agents that can be graded. The streak is scheduling state only;
-- it does not change public compliance evidence or badge status.
ALTER TABLE agent_registry_metadata
  ADD COLUMN compliance_inconclusive_streak INTEGER NOT NULL DEFAULT 0
  CHECK (compliance_inconclusive_streak BETWEEN 0 AND 4);
