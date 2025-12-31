-- Migration: 066_rule_contexts.sql
-- Add context field to rules for contextual rule application
--
-- Rules can now be tagged with a context that determines when they're applied:
-- - NULL or 'default': Always included in main system prompt
-- - 'engagement': Only used for "should I respond?" evaluation in channels
-- - 'admin': Only included when talking to admin users
-- - 'member': Only included when talking to organization members
-- - 'anonymous': Only included when talking to anonymous/unlinked users

ALTER TABLE addie_rules ADD COLUMN IF NOT EXISTS context VARCHAR(50) DEFAULT NULL;

-- Add index for filtering by context
CREATE INDEX IF NOT EXISTS idx_addie_rules_context ON addie_rules(context);

-- Add comment
COMMENT ON COLUMN addie_rules.context IS 'Context where this rule applies: NULL/default=main prompt, engagement=should-respond check, admin/member/anonymous=user type specific';

-- Migrate existing engagement rules to use context
UPDATE addie_rules SET context = 'engagement' WHERE rule_type = 'engagement';
