-- Add working_group_id to spec_insight_posts so we can track which group was posted to
-- and rotate across groups.

ALTER TABLE spec_insight_posts
ADD COLUMN IF NOT EXISTS working_group_id UUID REFERENCES working_groups(id);

CREATE INDEX IF NOT EXISTS idx_spec_insight_posts_wg ON spec_insight_posts(working_group_id, created_at DESC);
