-- Member Search Analytics
-- Tracks how member profiles appear in searches and introductions made through Addie

CREATE TABLE IF NOT EXISTS member_search_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What member profile was involved (nullable for searches with no results)
  member_profile_id UUID REFERENCES member_profiles(id) ON DELETE CASCADE,

  -- Type of event
  event_type VARCHAR(50) NOT NULL, -- 'search_impression', 'profile_click', 'introduction_request', 'introduction_sent'

  -- Search context
  search_query TEXT,  -- The natural language query used
  search_session_id UUID,  -- Groups events from same search operation

  -- Who was searching (may be anonymous)
  searcher_user_id VARCHAR(255),  -- WorkOS user ID if logged in
  searcher_email VARCHAR(255),  -- Email if provided for introduction
  searcher_name VARCHAR(255),  -- Name if provided for introduction
  searcher_company VARCHAR(255),  -- Company if provided for introduction

  -- Addie context
  addie_thread_id UUID,  -- Link to addie thread for full conversation context
  addie_message_id UUID,  -- Specific message that triggered this

  -- Additional context
  context JSONB DEFAULT '{}',  -- Additional metadata (position in results, etc.)

  -- Lifecycle
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_member_search_member ON member_search_analytics(member_profile_id);
CREATE INDEX IF NOT EXISTS idx_member_search_event_type ON member_search_analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_member_search_created ON member_search_analytics(created_at);
CREATE INDEX IF NOT EXISTS idx_member_search_session ON member_search_analytics(search_session_id);
CREATE INDEX IF NOT EXISTS idx_member_search_thread ON member_search_analytics(addie_thread_id);

-- Composite index for member dashboard queries
CREATE INDEX IF NOT EXISTS idx_member_search_dashboard
  ON member_search_analytics(member_profile_id, event_type, created_at DESC);
