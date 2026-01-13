-- Addie Escalations System
-- Tracks escalations when Addie encounters capability gaps or needs human help

CREATE TABLE addie_escalations (
  id SERIAL PRIMARY KEY,

  -- Source tracking
  thread_id UUID REFERENCES addie_threads(thread_id),
  message_id UUID REFERENCES addie_thread_messages(message_id),

  -- User who requested help
  slack_user_id TEXT,
  workos_user_id TEXT,
  user_display_name TEXT,

  -- Escalation details
  category TEXT NOT NULL CHECK (category IN (
    'capability_gap',       -- Addie can't do this action
    'needs_human_action',   -- Requires human to take action
    'complex_request',      -- Too complex for Addie
    'sensitive_topic',      -- Needs human judgment
    'other'
  )),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

  -- Context
  summary TEXT NOT NULL,
  original_request TEXT,
  addie_context TEXT,

  -- Notification tracking
  notification_channel_id TEXT,
  notification_sent_at TIMESTAMP WITH TIME ZONE,
  notification_message_ts TEXT,

  -- Resolution workflow
  status TEXT DEFAULT 'open' CHECK (status IN (
    'open',
    'acknowledged',
    'in_progress',
    'resolved',
    'wont_do',
    'expired'
  )),
  resolved_by TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolution_notes TEXT,

  -- Audit
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_escalations_status ON addie_escalations(status, created_at DESC);
CREATE INDEX idx_escalations_thread ON addie_escalations(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX idx_escalations_user ON addie_escalations(slack_user_id) WHERE slack_user_id IS NOT NULL;

-- Update trigger for updated_at
CREATE TRIGGER update_escalations_updated_at
  BEFORE UPDATE ON addie_escalations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
