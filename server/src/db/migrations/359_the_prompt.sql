-- The Prompt: link digest editions to their published perspective
ALTER TABLE weekly_digests ADD COLUMN perspective_id UUID REFERENCES perspectives(id);

CREATE UNIQUE INDEX idx_weekly_digests_perspective
  ON weekly_digests(perspective_id) WHERE perspective_id IS NOT NULL;
