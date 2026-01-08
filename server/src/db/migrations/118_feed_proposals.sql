-- Feed proposals - allows community members to propose news sources
-- Admins can review and approve proposals to add as industry feeds

CREATE TABLE IF NOT EXISTS feed_proposals (
  id SERIAL PRIMARY KEY,

  -- The proposed feed details
  url TEXT NOT NULL,                      -- URL of the proposed feed/site (may not be RSS)
  name TEXT,                              -- Suggested name (optional)
  reason TEXT,                            -- Why the proposer thinks it's relevant
  category TEXT,                          -- Suggested category

  -- Who proposed it and when
  proposed_by_slack_user_id TEXT,         -- Slack user who proposed
  proposed_by_workos_user_id TEXT,        -- WorkOS user who proposed (if known)
  proposed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Review status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'duplicate')),
  reviewed_by_workos_user_id TEXT,        -- Admin who reviewed
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,                      -- Admin notes on decision

  -- If approved, link to the created feed
  feed_id INTEGER REFERENCES industry_feeds(id),

  -- Source context (where the link was shared)
  source_channel_id TEXT,                 -- Slack channel where link was shared
  source_message_ts TEXT,                 -- Slack message timestamp

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for finding pending proposals
CREATE INDEX IF NOT EXISTS idx_feed_proposals_status ON feed_proposals(status);

-- Index for finding proposals by URL (for dedup)
CREATE INDEX IF NOT EXISTS idx_feed_proposals_url ON feed_proposals(url);
