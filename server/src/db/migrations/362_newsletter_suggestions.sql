-- Newsletter content suggestions from community members
-- Anyone can suggest content for The Prompt or The Build via Addie

CREATE TABLE newsletter_suggestions (
  id SERIAL PRIMARY KEY,
  newsletter_id TEXT NOT NULL,              -- 'the_prompt' or 'the_build'
  suggested_by_user_id TEXT NOT NULL,       -- workos_user_id of suggester
  suggested_by_name TEXT,                   -- display name at time of suggestion
  title TEXT NOT NULL,                      -- article/content title
  url TEXT,                                 -- optional URL
  description TEXT,                         -- why this should be included
  source_channel TEXT,                      -- 'slack_dm', 'slack_channel', 'web_chat'
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'included')),
  included_in_edition_date DATE,            -- which edition used this
  reviewed_by TEXT,                         -- admin who accepted/declined
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_newsletter_suggestions_status ON newsletter_suggestions(status);
CREATE INDEX idx_newsletter_suggestions_newsletter ON newsletter_suggestions(newsletter_id, status);
CREATE INDEX idx_newsletter_suggestions_user ON newsletter_suggestions(suggested_by_user_id);
