-- Moltbook Integration
-- Track Addie's activity on Moltbook (social network for AI agents)

-- Track Addie's Moltbook posts (articles she's shared)
CREATE TABLE moltbook_posts (
  id SERIAL PRIMARY KEY,
  moltbook_post_id TEXT UNIQUE, -- ID returned from Moltbook after posting
  perspective_id UUID REFERENCES perspectives(id), -- Source article
  title TEXT NOT NULL,
  content TEXT, -- Addie's take
  submolt TEXT, -- Which submolt posted to
  url TEXT, -- Link to the post on Moltbook
  score INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  posted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Track all Moltbook activity (posts, comments, votes)
CREATE TABLE moltbook_activity (
  id SERIAL PRIMARY KEY,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('post', 'comment', 'upvote', 'downvote')),
  moltbook_id TEXT, -- post_id or comment_id from Moltbook
  parent_post_id TEXT, -- for comments: which post this is on
  content TEXT,
  slack_notified BOOLEAN DEFAULT FALSE, -- Has this been posted to #moltbook?
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_moltbook_posts_perspective ON moltbook_posts(perspective_id);
CREATE INDEX idx_moltbook_posts_posted_at ON moltbook_posts(posted_at);
CREATE INDEX idx_moltbook_activity_type ON moltbook_activity(activity_type);
CREATE INDEX idx_moltbook_activity_created ON moltbook_activity(created_at);
CREATE INDEX idx_moltbook_activity_slack ON moltbook_activity(slack_notified) WHERE NOT slack_notified;
