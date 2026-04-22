-- Add parent_id to working_groups to support nested committee hierarchy.
-- Subgroups are first-class working groups that live under a parent, useful
-- for consolidating dead groups as topics of a living parent without losing
-- members, documents, or history.

ALTER TABLE working_groups
ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES working_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_working_groups_parent_id
  ON working_groups(parent_id)
  WHERE parent_id IS NOT NULL;

COMMENT ON COLUMN working_groups.parent_id IS 'Optional parent working group for nested hierarchy. NULL for top-level groups.';
