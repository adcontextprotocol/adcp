-- Migration: 101_outreach_sentiment.sql
-- Enhanced outreach tracking: sentiment detection, refusal handling, scheduling
--
-- Addresses red team findings:
-- 1. No mechanism to detect explicit refusals
-- 2. Binary response tracking doesn't capture sentiment
-- 3. No grace period tracking for new members
-- 4. No "remind me later" intent parsing

-- =====================================================
-- ENHANCE MEMBER_OUTREACH TABLE
-- =====================================================

-- Add response sentiment and content tracking
ALTER TABLE member_outreach
ADD COLUMN IF NOT EXISTS response_text TEXT,
ADD COLUMN IF NOT EXISTS response_sentiment VARCHAR(20)
  CHECK (response_sentiment IN ('positive', 'neutral', 'negative', 'refusal')),
ADD COLUMN IF NOT EXISTS response_intent VARCHAR(50)
  CHECK (response_intent IN (
    'converted',      -- User linked/signed up
    'interested',     -- Positive response, may convert later
    'deferred',       -- "Remind me later" / busy now
    'question',       -- Asked a question
    'objection',      -- Raised concern/objection
    'refusal',        -- Explicit no
    'ignored'         -- No response at all
  )),
ADD COLUMN IF NOT EXISTS follow_up_date DATE,
ADD COLUMN IF NOT EXISTS follow_up_reason TEXT;

-- Index for sentiment analysis
CREATE INDEX IF NOT EXISTS idx_outreach_sentiment ON member_outreach(response_sentiment)
  WHERE response_sentiment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_intent ON member_outreach(response_intent)
  WHERE response_intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_follow_up ON member_outreach(follow_up_date)
  WHERE follow_up_date IS NOT NULL;

-- =====================================================
-- ENHANCE SLACK_USER_MAPPINGS
-- =====================================================

-- Add grace period tracking and role-based targeting
ALTER TABLE slack_user_mappings
ADD COLUMN IF NOT EXISTS slack_joined_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS detected_role VARCHAR(50),
ADD COLUMN IF NOT EXISTS detected_seniority VARCHAR(20)
  CHECK (detected_seniority IN ('executive', 'senior', 'mid', 'junior', 'unknown'));

-- Index for grace period queries
CREATE INDEX IF NOT EXISTS idx_slack_mapping_joined ON slack_user_mappings(slack_joined_at)
  WHERE slack_joined_at IS NOT NULL;

-- =====================================================
-- REFUSAL PATTERNS TABLE
-- =====================================================
-- Track patterns that indicate explicit refusal/opt-out

CREATE TABLE IF NOT EXISTS outreach_refusal_patterns (
  id SERIAL PRIMARY KEY,
  pattern VARCHAR(255) NOT NULL UNIQUE,
  pattern_type VARCHAR(20) NOT NULL CHECK (pattern_type IN ('exact', 'contains', 'regex')),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('hard', 'soft')),
  -- hard = never contact again, soft = wait longer before retry
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed common refusal patterns
INSERT INTO outreach_refusal_patterns (pattern, pattern_type, severity, description) VALUES
  -- Hard refusals (never contact again automatically)
  ('not interested', 'contains', 'hard', 'Explicit disinterest'),
  ('no thanks', 'contains', 'hard', 'Polite refusal'),
  ('don''t contact', 'contains', 'hard', 'Explicit opt-out request'),
  ('stop messaging', 'contains', 'hard', 'Explicit stop request'),
  ('unsubscribe', 'contains', 'hard', 'Opt-out language'),
  ('leave me alone', 'contains', 'hard', 'Strong refusal'),
  ('not for me', 'contains', 'hard', 'Disinterest'),
  ('please stop', 'contains', 'hard', 'Stop request'),

  -- Soft refusals (extend rate limit significantly)
  ('maybe later', 'contains', 'soft', 'Deferred interest'),
  ('not right now', 'contains', 'soft', 'Timing issue'),
  ('too busy', 'contains', 'soft', 'Capacity issue'),
  ('check back', 'contains', 'soft', 'Future interest indicated')
ON CONFLICT (pattern) DO NOTHING;

-- =====================================================
-- DEFER INTENT PATTERNS TABLE
-- =====================================================
-- Track patterns that indicate "remind me later"

CREATE TABLE IF NOT EXISTS outreach_defer_patterns (
  id SERIAL PRIMARY KEY,
  pattern VARCHAR(255) NOT NULL UNIQUE,
  pattern_type VARCHAR(20) NOT NULL CHECK (pattern_type IN ('exact', 'contains', 'regex')),
  default_days INTEGER NOT NULL DEFAULT 30, -- How long to wait
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed common defer patterns
INSERT INTO outreach_defer_patterns (pattern, pattern_type, default_days, description) VALUES
  ('next month', 'contains', 30, 'One month defer'),
  ('next week', 'contains', 7, 'One week defer'),
  ('in a few weeks', 'contains', 21, 'Three week defer'),
  ('after the holidays', 'contains', 14, 'Post-holiday defer'),
  ('q1', 'contains', 45, 'Next quarter defer'),
  ('q2', 'contains', 45, 'Next quarter defer'),
  ('q3', 'contains', 45, 'Next quarter defer'),
  ('q4', 'contains', 45, 'Next quarter defer'),
  ('end of month', 'contains', 14, 'End of month defer'),
  ('remind me', 'contains', 30, 'Generic reminder request'),
  ('ping me', 'contains', 30, 'Generic reminder request'),
  ('reach out again', 'contains', 30, 'Generic reminder request'),
  ('follow up', 'contains', 14, 'Follow-up request'),
  ('circle back', 'contains', 14, 'Follow-up request'),
  ('when I have bandwidth', 'contains', 30, 'Capacity-based defer'),
  ('when things calm down', 'contains', 30, 'Capacity-based defer')
ON CONFLICT (pattern) DO NOTHING;

-- =====================================================
-- FUNCTIONS FOR RESPONSE ANALYSIS
-- =====================================================

-- Function to check if a response indicates refusal
CREATE OR REPLACE FUNCTION check_refusal_pattern(response_text TEXT)
RETURNS TABLE (
  is_refusal BOOLEAN,
  severity VARCHAR(20),
  matched_pattern VARCHAR(255)
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    TRUE as is_refusal,
    p.severity,
    p.pattern as matched_pattern
  FROM outreach_refusal_patterns p
  WHERE p.is_active = TRUE
    AND (
      (p.pattern_type = 'contains' AND LOWER(response_text) LIKE '%' || LOWER(p.pattern) || '%')
      OR (p.pattern_type = 'exact' AND LOWER(response_text) = LOWER(p.pattern))
    )
  LIMIT 1;

  -- If no rows returned, return false
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::VARCHAR(20), NULL::VARCHAR(255);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to check if a response indicates defer intent
CREATE OR REPLACE FUNCTION check_defer_pattern(response_text TEXT)
RETURNS TABLE (
  is_defer BOOLEAN,
  defer_days INTEGER,
  matched_pattern VARCHAR(255)
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    TRUE as is_defer,
    p.default_days as defer_days,
    p.pattern as matched_pattern
  FROM outreach_defer_patterns p
  WHERE p.is_active = TRUE
    AND (
      (p.pattern_type = 'contains' AND LOWER(response_text) LIKE '%' || LOWER(p.pattern) || '%')
      OR (p.pattern_type = 'exact' AND LOWER(response_text) = LOWER(p.pattern))
    )
  ORDER BY p.default_days DESC  -- Prefer longer defer periods if multiple match
  LIMIT 1;

  -- If no rows returned, return false
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, NULL::VARCHAR(255);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to analyze response and determine intent/sentiment
CREATE OR REPLACE FUNCTION analyze_outreach_response(response_text TEXT)
RETURNS TABLE (
  sentiment VARCHAR(20),
  intent VARCHAR(50),
  follow_up_days INTEGER,
  analysis_note TEXT
) AS $$
DECLARE
  refusal_result RECORD;
  defer_result RECORD;
BEGIN
  -- Check for refusal patterns first (highest priority)
  SELECT * INTO refusal_result FROM check_refusal_pattern(response_text);

  IF refusal_result.is_refusal THEN
    RETURN QUERY SELECT
      'refusal'::VARCHAR(20) as sentiment,
      'refusal'::VARCHAR(50) as intent,
      NULL::INTEGER as follow_up_days,
      ('Matched refusal pattern: ' || refusal_result.matched_pattern)::TEXT as analysis_note;
    RETURN;
  END IF;

  -- Check for defer patterns
  SELECT * INTO defer_result FROM check_defer_pattern(response_text);

  IF defer_result.is_defer THEN
    RETURN QUERY SELECT
      'neutral'::VARCHAR(20) as sentiment,
      'deferred'::VARCHAR(50) as intent,
      defer_result.defer_days as follow_up_days,
      ('Matched defer pattern: ' || defer_result.matched_pattern)::TEXT as analysis_note;
    RETURN;
  END IF;

  -- Check for positive indicators
  IF LOWER(response_text) ~ '(done|linked|thanks|great|awesome|perfect|love|excited)' THEN
    RETURN QUERY SELECT
      'positive'::VARCHAR(20) as sentiment,
      'interested'::VARCHAR(50) as intent,
      NULL::INTEGER as follow_up_days,
      'Positive response indicators detected'::TEXT as analysis_note;
    RETURN;
  END IF;

  -- Check for questions (indicates engagement)
  IF response_text ~ '\?' THEN
    RETURN QUERY SELECT
      'neutral'::VARCHAR(20) as sentiment,
      'question'::VARCHAR(50) as intent,
      NULL::INTEGER as follow_up_days,
      'User asked a question - engage further'::TEXT as analysis_note;
    RETURN;
  END IF;

  -- Default to neutral/interested if they responded at all
  RETURN QUERY SELECT
    'neutral'::VARCHAR(20) as sentiment,
    'interested'::VARCHAR(50) as intent,
    NULL::INTEGER as follow_up_days,
    'Response received - no specific pattern matched'::TEXT as analysis_note;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEWS FOR OUTREACH ANALYSIS
-- =====================================================

-- Enhanced outreach stats with sentiment breakdown
CREATE OR REPLACE VIEW outreach_sentiment_stats AS
SELECT
  response_sentiment,
  response_intent,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) as percentage
FROM member_outreach
WHERE user_responded = TRUE
GROUP BY response_sentiment, response_intent
ORDER BY count DESC;

-- Users needing follow-up (scheduled)
CREATE OR REPLACE VIEW outreach_scheduled_followups AS
SELECT
  mo.id as outreach_id,
  mo.slack_user_id,
  sm.slack_real_name,
  sm.slack_display_name,
  sm.slack_email,
  mo.follow_up_date,
  mo.follow_up_reason,
  mo.response_text,
  mo.sent_at as original_outreach_at
FROM member_outreach mo
JOIN slack_user_mappings sm ON sm.slack_user_id = mo.slack_user_id
WHERE mo.follow_up_date IS NOT NULL
  AND mo.follow_up_date <= CURRENT_DATE + INTERVAL '7 days'
  AND NOT EXISTS (
    -- No newer outreach to this user
    SELECT 1 FROM member_outreach mo2
    WHERE mo2.slack_user_id = mo.slack_user_id
      AND mo2.sent_at > mo.sent_at
  )
ORDER BY mo.follow_up_date;

-- Users who explicitly refused (should not be contacted)
CREATE OR REPLACE VIEW outreach_refused_users AS
SELECT
  mo.slack_user_id,
  sm.slack_real_name,
  sm.slack_display_name,
  sm.slack_email,
  mo.response_text,
  mo.sent_at as refused_at
FROM member_outreach mo
JOIN slack_user_mappings sm ON sm.slack_user_id = mo.slack_user_id
WHERE mo.response_sentiment = 'refusal'
  OR mo.response_intent = 'refusal'
ORDER BY mo.sent_at DESC;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE outreach_refusal_patterns IS 'Patterns indicating explicit opt-out from outreach';
COMMENT ON TABLE outreach_defer_patterns IS 'Patterns indicating "remind me later" intent';
COMMENT ON COLUMN member_outreach.response_sentiment IS 'Detected sentiment: positive, neutral, negative, refusal';
COMMENT ON COLUMN member_outreach.response_intent IS 'Detected intent: converted, interested, deferred, question, objection, refusal, ignored';
COMMENT ON COLUMN member_outreach.follow_up_date IS 'Scheduled follow-up date if user requested to be contacted later';
COMMENT ON COLUMN slack_user_mappings.slack_joined_at IS 'When user joined Slack (for grace period calculation)';
COMMENT ON COLUMN slack_user_mappings.detected_seniority IS 'Inferred seniority level for tone matching';
