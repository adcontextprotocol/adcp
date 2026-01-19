-- Migration: SI (Sponsored Intelligence) Agent Configuration
-- Enables members to configure SI agents for conversational brand experiences

-- Add SI configuration columns to member_profiles
ALTER TABLE member_profiles
ADD COLUMN IF NOT EXISTS si_enabled BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS si_endpoint_url TEXT,
ADD COLUMN IF NOT EXISTS si_capabilities JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS si_prompt_template TEXT,
ADD COLUMN IF NOT EXISTS si_skills TEXT[] DEFAULT '{}';

-- Create SI sessions table for tracking active and historical sessions
CREATE TABLE IF NOT EXISTS si_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR NOT NULL UNIQUE,

    -- Who initiated
    host_type VARCHAR NOT NULL CHECK (host_type IN ('addy', 'external')),
    host_identifier VARCHAR NOT NULL,

    -- The brand being connected to
    member_profile_id UUID REFERENCES member_profiles(id),
    brand_name VARCHAR NOT NULL,

    -- The user interacting (if known)
    user_slack_id VARCHAR,
    user_email VARCHAR,
    user_name VARCHAR,
    user_anonymous_id VARCHAR,
    identity_consent_granted BOOLEAN DEFAULT false,

    -- Session state
    status VARCHAR NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_handoff', 'complete', 'timeout', 'error')),
    termination_reason VARCHAR CHECK (termination_reason IN ('handoff_transaction', 'handoff_complete', 'user_exit', 'session_timeout', 'host_terminated')),

    -- Context
    initial_context TEXT,
    campaign_id VARCHAR,
    offer_id VARCHAR,

    -- Handoff data (for transaction handoffs)
    handoff_data JSONB,

    -- Conversation metrics
    message_count INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    terminated_at TIMESTAMPTZ
);

-- Create SI session messages table for conversation history and cross-session memory
CREATE TABLE IF NOT EXISTS si_session_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR NOT NULL REFERENCES si_sessions(session_id) ON DELETE CASCADE,

    -- Message details
    role VARCHAR NOT NULL CHECK (role IN ('user', 'brand_agent', 'system')),
    content TEXT NOT NULL,

    -- UI elements returned by brand agent
    ui_elements JSONB,

    -- Action responses (button clicks, etc.)
    action_response JSONB,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create SI relationship memory table for cross-session context
-- This stores persistent knowledge about user-brand relationships
CREATE TABLE IF NOT EXISTS si_relationship_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Unique relationship identifier (user + brand)
    user_identifier VARCHAR NOT NULL,  -- email, slack_id, or anonymous_id
    user_identifier_type VARCHAR NOT NULL CHECK (user_identifier_type IN ('email', 'slack_id', 'anonymous')),
    member_profile_id UUID REFERENCES member_profiles(id),

    -- Relationship data
    total_sessions INTEGER DEFAULT 0,
    last_session_id VARCHAR REFERENCES si_sessions(session_id),

    -- Memory/context that persists across sessions
    -- This is what makes the SI agent "remember" the user
    memory JSONB DEFAULT '{}'::jsonb,
    -- Example: { "preferences": {...}, "past_interests": [...], "signup_status": "interested", "last_topic": "pricing" }

    -- Engagement tracking
    first_interaction_at TIMESTAMPTZ DEFAULT NOW(),
    last_interaction_at TIMESTAMPTZ DEFAULT NOW(),

    -- Lead status (for tracking conversion)
    lead_status VARCHAR CHECK (lead_status IN ('new', 'engaged', 'qualified', 'converted', 'churned')),
    lead_status_updated_at TIMESTAMPTZ,

    -- Notes for the brand (CRM-like)
    notes TEXT,

    UNIQUE (user_identifier, user_identifier_type, member_profile_id)
);

-- Create SI skills table for defining actions the SI agent can take
CREATE TABLE IF NOT EXISTS si_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_profile_id UUID REFERENCES member_profiles(id),

    -- Skill definition
    skill_name VARCHAR NOT NULL,
    skill_description TEXT NOT NULL,
    skill_type VARCHAR NOT NULL CHECK (skill_type IN ('signup', 'demo_request', 'implementation_help', 'contact_sales', 'documentation', 'custom')),

    -- Configuration
    config JSONB DEFAULT '{}'::jsonb,
    -- Example for signup: { "form_fields": ["email", "company"], "redirect_url": "...", "confirmation_message": "..." }
    -- Example for demo_request: { "calendar_link": "...", "sales_email": "..." }

    -- Whether this skill is active
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (member_profile_id, skill_name)
);

-- Create SI skill executions table for tracking skill usage
CREATE TABLE IF NOT EXISTS si_skill_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR REFERENCES si_sessions(session_id),
    skill_id UUID REFERENCES si_skills(id),

    -- Execution details
    input_data JSONB,
    output_data JSONB,
    status VARCHAR NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,

    -- Timestamps
    executed_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_si_sessions_member_profile ON si_sessions(member_profile_id);
CREATE INDEX IF NOT EXISTS idx_si_sessions_status ON si_sessions(status);
CREATE INDEX IF NOT EXISTS idx_si_sessions_user_slack ON si_sessions(user_slack_id) WHERE user_slack_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_si_sessions_user_email ON si_sessions(user_email) WHERE user_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_si_sessions_created_at ON si_sessions(created_at);

CREATE INDEX IF NOT EXISTS idx_si_session_messages_session ON si_session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_si_session_messages_created ON si_session_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_si_relationship_memory_user ON si_relationship_memory(user_identifier, user_identifier_type);
CREATE INDEX IF NOT EXISTS idx_si_relationship_memory_member ON si_relationship_memory(member_profile_id);
CREATE INDEX IF NOT EXISTS idx_si_relationship_memory_lead ON si_relationship_memory(lead_status) WHERE lead_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_si_skills_member ON si_skills(member_profile_id);
CREATE INDEX IF NOT EXISTS idx_si_skill_executions_session ON si_skill_executions(session_id);

-- Add trigger for updating member_profiles.updated_at when SI config changes
-- (Assuming the trigger already exists from previous migrations)

COMMENT ON TABLE si_sessions IS 'Tracks active and historical SI (Sponsored Intelligence) sessions between users and brand agents';
COMMENT ON TABLE si_session_messages IS 'Stores conversation history for SI sessions';
COMMENT ON TABLE si_relationship_memory IS 'Persists context and memory about user-brand relationships across sessions';
COMMENT ON TABLE si_skills IS 'Defines actions that SI agents can take (signup, demo request, etc.)';
COMMENT ON TABLE si_skill_executions IS 'Tracks execution of SI skills for analytics and debugging';

COMMENT ON COLUMN member_profiles.si_enabled IS 'Whether this member has SI agent enabled';
COMMENT ON COLUMN member_profiles.si_endpoint_url IS 'Custom SI endpoint URL (if not using default agent)';
COMMENT ON COLUMN member_profiles.si_capabilities IS 'SI capabilities configuration (modalities, components, commerce)';
COMMENT ON COLUMN member_profiles.si_prompt_template IS 'Custom prompt template for default SI agent';
COMMENT ON COLUMN member_profiles.si_skills IS 'Array of enabled skill types for this member';
