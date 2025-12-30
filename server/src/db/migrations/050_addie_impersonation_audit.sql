-- Migration: 048_addie_impersonation_audit.sql
-- Add impersonation tracking to Addie conversations for audit purposes

-- Add impersonation columns to conversations table
ALTER TABLE addie_conversations
ADD COLUMN IF NOT EXISTS impersonator_email VARCHAR(255),
ADD COLUMN IF NOT EXISTS impersonation_reason TEXT;

-- Add impersonation columns to messages table (for per-message audit)
ALTER TABLE addie_messages
ADD COLUMN IF NOT EXISTS impersonator_email VARCHAR(255);

-- Index for finding impersonated conversations
CREATE INDEX IF NOT EXISTS idx_addie_conversations_impersonator
ON addie_conversations(impersonator_email)
WHERE impersonator_email IS NOT NULL;

-- Comments
COMMENT ON COLUMN addie_conversations.impersonator_email IS 'Email of admin who impersonated this user (from WorkOS impersonation)';
COMMENT ON COLUMN addie_conversations.impersonation_reason IS 'Reason provided for impersonation';
COMMENT ON COLUMN addie_messages.impersonator_email IS 'Email of admin who impersonated this user when sending this message';
