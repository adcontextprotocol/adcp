-- Keep the Slack announcement associated with a pending community-mirror
-- proposal so the eventual decision can be posted as a threaded reply.
ALTER TABLE community_mirror_proposals
  ADD COLUMN IF NOT EXISTS slack_thread_ts TEXT;
