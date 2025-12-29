-- Migration: 044_addie_conversations.sql
-- Store Addie chat conversations for training and analysis

-- Conversations table - groups messages together
CREATE TABLE IF NOT EXISTS addie_conversations (
    id SERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    user_id VARCHAR(255),  -- WorkOS user ID if authenticated, NULL for anonymous
    user_name VARCHAR(255),  -- Display name for chat
    channel VARCHAR(50) NOT NULL DEFAULT 'web',  -- 'web', 'slack', etc.
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    message_count INTEGER NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',  -- Additional context (user agent, etc.)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Messages table - individual messages in a conversation
CREATE TABLE IF NOT EXISTS addie_messages (
    id SERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES addie_conversations(conversation_id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    tool_use JSONB,  -- Tool calls made by assistant
    tool_results JSONB,  -- Results from tool calls
    tokens_input INTEGER,  -- Token usage tracking
    tokens_output INTEGER,
    model VARCHAR(100),  -- Model used (claude-sonnet-4-20250514, etc.)
    latency_ms INTEGER,  -- Response time
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_addie_conversations_user ON addie_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_addie_conversations_channel ON addie_conversations(channel);
CREATE INDEX IF NOT EXISTS idx_addie_conversations_started ON addie_conversations(started_at);
CREATE INDEX IF NOT EXISTS idx_addie_messages_conversation ON addie_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_addie_messages_created ON addie_messages(created_at);

-- Comments
COMMENT ON TABLE addie_conversations IS 'Chat conversations with Addie for training and analysis';
COMMENT ON TABLE addie_messages IS 'Individual messages within Addie conversations';
COMMENT ON COLUMN addie_conversations.channel IS 'Source channel: web, slack, etc.';
COMMENT ON COLUMN addie_messages.tool_use IS 'JSON array of tool calls made by assistant';
COMMENT ON COLUMN addie_messages.tool_results IS 'JSON array of tool call results';
