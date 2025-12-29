-- Migration: 045_addie_message_feedback.sql
-- Add feedback columns to addie_messages for comprehensive response rating

-- Add feedback columns to messages
ALTER TABLE addie_messages
  ADD COLUMN IF NOT EXISTS rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  ADD COLUMN IF NOT EXISTS rating_category VARCHAR(50),  -- 'accuracy', 'helpfulness', 'completeness', etc.
  ADD COLUMN IF NOT EXISTS feedback_text TEXT,
  ADD COLUMN IF NOT EXISTS feedback_tags JSONB DEFAULT '[]',  -- ['missing_info', 'wrong_answer', 'too_long', etc.]
  ADD COLUMN IF NOT EXISTS improvement_suggestion TEXT,  -- User's suggestion for how to improve
  ADD COLUMN IF NOT EXISTS rated_by VARCHAR(255),  -- User ID who rated
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMP WITH TIME ZONE;

-- Index for finding messages with feedback
CREATE INDEX IF NOT EXISTS idx_addie_messages_rating ON addie_messages(rating) WHERE rating IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_addie_messages_rated_at ON addie_messages(rated_at) WHERE rated_at IS NOT NULL;

-- Feedback summary view for analysis
CREATE OR REPLACE VIEW addie_feedback_summary AS
SELECT
  DATE_TRUNC('day', rated_at) as day,
  COUNT(*) as total_ratings,
  COUNT(*) FILTER (WHERE rating >= 4) as positive_ratings,
  COUNT(*) FILTER (WHERE rating <= 2) as negative_ratings,
  ROUND(AVG(rating)::numeric, 2) as avg_rating,
  COUNT(*) FILTER (WHERE improvement_suggestion IS NOT NULL) as with_suggestions
FROM addie_messages
WHERE rating IS NOT NULL
GROUP BY DATE_TRUNC('day', rated_at)
ORDER BY day DESC;

-- Common feedback tags aggregation
CREATE OR REPLACE VIEW addie_feedback_tags AS
SELECT
  jsonb_array_elements_text(feedback_tags) as tag,
  COUNT(*) as count
FROM addie_messages
WHERE feedback_tags IS NOT NULL AND feedback_tags != '[]'::jsonb
GROUP BY jsonb_array_elements_text(feedback_tags)
ORDER BY count DESC;

COMMENT ON COLUMN addie_messages.rating IS 'User rating 1-5 (1=poor, 5=excellent)';
COMMENT ON COLUMN addie_messages.rating_category IS 'Primary category of feedback: accuracy, helpfulness, completeness, tone';
COMMENT ON COLUMN addie_messages.feedback_tags IS 'Array of specific feedback tags like missing_info, wrong_answer, too_verbose';
COMMENT ON COLUMN addie_messages.improvement_suggestion IS 'Free-form suggestion from user on how to improve';
