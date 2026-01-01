-- =====================================================
-- CONFIGURATION VERSIONING FOR ADDIE
-- =====================================================
-- Track configuration versions (rules + router) so we can:
-- 1. Log a simple version_id with each message instead of full config
-- 2. Analyze feedback by configuration version
-- 3. Know exactly what config produced which responses

-- Config versions table - stores snapshots of active configuration
CREATE TABLE IF NOT EXISTS addie_config_versions (
  version_id SERIAL PRIMARY KEY,

  -- Hash of the configuration (for quick lookup)
  -- Computed from: sorted rule IDs + router rules hash
  config_hash VARCHAR(64) NOT NULL UNIQUE,

  -- What's in this version
  active_rule_ids INTEGER[] NOT NULL,
  rules_snapshot JSONB NOT NULL,  -- Full rule content at time of capture
  router_rules_hash VARCHAR(64),  -- Hash of ROUTING_RULES from router.ts

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Stats (updated incrementally)
  message_count INTEGER DEFAULT 0,
  positive_feedback INTEGER DEFAULT 0,
  negative_feedback INTEGER DEFAULT 0,
  avg_rating DECIMAL(3,2)
);

-- Index for hash lookups
CREATE INDEX IF NOT EXISTS idx_addie_config_versions_hash ON addie_config_versions(config_hash);

-- Add config_version_id to messages (nullable for backward compat)
ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS config_version_id INTEGER REFERENCES addie_config_versions(version_id);

-- Index for analyzing messages by config version
CREATE INDEX IF NOT EXISTS idx_addie_messages_config_version ON addie_thread_messages(config_version_id)
  WHERE config_version_id IS NOT NULL;

-- Function to update config version stats when feedback is added
CREATE OR REPLACE FUNCTION update_config_version_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Only update if rating changed and config_version_id exists
  IF (NEW.rating IS DISTINCT FROM OLD.rating) AND NEW.config_version_id IS NOT NULL THEN
    UPDATE addie_config_versions cv
    SET
      positive_feedback = (
        SELECT COUNT(*) FROM addie_thread_messages
        WHERE config_version_id = NEW.config_version_id AND rating >= 4
      ),
      negative_feedback = (
        SELECT COUNT(*) FROM addie_thread_messages
        WHERE config_version_id = NEW.config_version_id AND rating <= 2
      ),
      avg_rating = (
        SELECT ROUND(AVG(rating)::numeric, 2) FROM addie_thread_messages
        WHERE config_version_id = NEW.config_version_id AND rating IS NOT NULL
      )
    WHERE cv.version_id = NEW.config_version_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_config_version_stats ON addie_thread_messages;
CREATE TRIGGER trigger_update_config_version_stats
AFTER UPDATE OF rating ON addie_thread_messages
FOR EACH ROW
EXECUTE FUNCTION update_config_version_stats();

-- Trigger to increment message count when new message with config_version_id is added
CREATE OR REPLACE FUNCTION increment_config_version_message_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.config_version_id IS NOT NULL THEN
    UPDATE addie_config_versions
    SET message_count = message_count + 1
    WHERE version_id = NEW.config_version_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_increment_config_message_count ON addie_thread_messages;
CREATE TRIGGER trigger_increment_config_message_count
AFTER INSERT ON addie_thread_messages
FOR EACH ROW
EXECUTE FUNCTION increment_config_version_message_count();

-- View for config version analysis
CREATE OR REPLACE VIEW addie_config_version_analysis AS
SELECT
  cv.version_id,
  cv.config_hash,
  cv.created_at,
  array_length(cv.active_rule_ids, 1) as rule_count,
  cv.message_count,
  cv.positive_feedback,
  cv.negative_feedback,
  cv.avg_rating,
  CASE
    WHEN cv.positive_feedback + cv.negative_feedback > 0
    THEN ROUND(cv.positive_feedback::numeric / (cv.positive_feedback + cv.negative_feedback), 3)
    ELSE NULL
  END as approval_rate,
  -- Latest message with this config
  (SELECT MAX(created_at) FROM addie_thread_messages WHERE config_version_id = cv.version_id) as last_used_at
FROM addie_config_versions cv
ORDER BY cv.created_at DESC;

COMMENT ON TABLE addie_config_versions IS 'Snapshots of Addie configuration (rules + router) for tracking changes and feedback by version';
COMMENT ON COLUMN addie_config_versions.config_hash IS 'SHA-256 hash of sorted rule IDs + router rules for quick deduplication';
COMMENT ON COLUMN addie_thread_messages.config_version_id IS 'Configuration version active when this message was processed';
