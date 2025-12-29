-- Addie Learning System Migration
-- Tables for rules management, Claude suggestions, and A/B testing

-- =====================================================
-- ADDIE RULES (Operating Instructions)
-- =====================================================
-- Rules that define Addie's behavior, managed via admin UI
-- Not committed to code - editable by non-engineers

CREATE TABLE IF NOT EXISTS addie_rules (
  id SERIAL PRIMARY KEY,

  -- Rule classification
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'system_prompt',    -- Core personality and instructions
    'behavior',         -- Specific behavioral guidelines
    'knowledge',        -- Domain knowledge and facts
    'constraint',       -- Things Addie should NOT do
    'response_style'    -- Tone and formatting preferences
  )),

  -- Rule content
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,

  -- Ordering and activation
  priority INTEGER DEFAULT 0,  -- Higher = applied first
  is_active BOOLEAN DEFAULT TRUE,

  -- Versioning
  version INTEGER DEFAULT 1,
  supersedes_rule_id INTEGER REFERENCES addie_rules(id),

  -- Performance tracking
  interactions_count INTEGER DEFAULT 0,
  positive_ratings INTEGER DEFAULT 0,
  negative_ratings INTEGER DEFAULT 0,
  avg_rating DECIMAL(3,2),

  -- Audit
  created_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient rule loading
CREATE INDEX IF NOT EXISTS idx_addie_rules_active ON addie_rules(is_active, rule_type, priority DESC);

-- =====================================================
-- ADDIE RULE SUGGESTIONS (Claude's Recommendations)
-- =====================================================
-- Claude analyzes interactions and suggests improvements
-- Humans review and approve/reject suggestions

CREATE TABLE IF NOT EXISTS addie_rule_suggestions (
  id SERIAL PRIMARY KEY,

  -- Suggestion type
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN (
    'new_rule',       -- Propose a completely new rule
    'modify_rule',    -- Suggest changes to existing rule
    'disable_rule',   -- Recommend disabling a rule
    'merge_rules',    -- Combine multiple rules
    'experiment'      -- Propose an A/B test
  )),

  -- Target rule (null for new_rule)
  target_rule_id INTEGER REFERENCES addie_rules(id),

  -- Suggestion content
  suggested_name TEXT,
  suggested_content TEXT NOT NULL,
  suggested_rule_type TEXT,

  -- Claude's analysis
  reasoning TEXT NOT NULL,
  evidence JSONB,  -- Interaction IDs, patterns found, etc.
  confidence DECIMAL(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  expected_impact TEXT,

  -- Supporting data
  supporting_interactions JSONB,  -- Array of interaction IDs that informed this
  pattern_summary TEXT,           -- Human-readable pattern description

  -- Review workflow
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending',     -- Awaiting review
    'approved',    -- Approved, ready to apply
    'rejected',    -- Rejected with reason
    'applied',     -- Applied to rules
    'superseded'   -- Another suggestion took precedence
  )),
  reviewed_by TEXT,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_notes TEXT,

  -- Application tracking
  applied_at TIMESTAMP WITH TIME ZONE,
  resulting_rule_id INTEGER REFERENCES addie_rules(id),

  -- Analysis batch reference
  analysis_batch_id TEXT,  -- Groups suggestions from same analysis run

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for pending suggestions
CREATE INDEX IF NOT EXISTS idx_addie_suggestions_pending ON addie_rule_suggestions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_addie_suggestions_batch ON addie_rule_suggestions(analysis_batch_id);

-- =====================================================
-- ADDIE EXPERIMENTS (A/B Testing)
-- =====================================================
-- Test rule variations to measure impact

CREATE TABLE IF NOT EXISTS addie_experiments (
  id SERIAL PRIMARY KEY,

  -- Experiment definition
  name TEXT NOT NULL,
  description TEXT,
  hypothesis TEXT NOT NULL,

  -- Rule configurations
  control_rules JSONB NOT NULL,  -- Rule IDs for control group
  variant_rules JSONB NOT NULL,  -- Rule IDs for variant group

  -- Traffic allocation
  traffic_split DECIMAL(3,2) DEFAULT 0.50 CHECK (traffic_split >= 0 AND traffic_split <= 1),

  -- Status
  status TEXT DEFAULT 'draft' CHECK (status IN (
    'draft',      -- Being configured
    'running',    -- Active experiment
    'paused',     -- Temporarily stopped
    'completed',  -- Finished with results
    'cancelled'   -- Stopped without results
  )),

  -- Timeline
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  target_interactions INTEGER,  -- Auto-complete after N interactions

  -- Results
  control_interactions INTEGER DEFAULT 0,
  variant_interactions INTEGER DEFAULT 0,
  control_positive INTEGER DEFAULT 0,
  control_negative INTEGER DEFAULT 0,
  variant_positive INTEGER DEFAULT 0,
  variant_negative INTEGER DEFAULT 0,
  control_avg_rating DECIMAL(3,2),
  variant_avg_rating DECIMAL(3,2),

  -- Conclusion
  winner TEXT CHECK (winner IN ('control', 'variant', 'inconclusive', NULL)),
  statistical_significance DECIMAL(5,4),
  conclusion TEXT,

  -- Audit
  created_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- ADDIE ANALYSIS RUNS
-- =====================================================
-- Track automated analysis jobs

CREATE TABLE IF NOT EXISTS addie_analysis_runs (
  id SERIAL PRIMARY KEY,

  -- Analysis scope
  analysis_type TEXT NOT NULL CHECK (analysis_type IN (
    'scheduled',     -- Regular scheduled analysis
    'manual',        -- Triggered manually
    'threshold',     -- Triggered by interaction threshold
    'feedback'       -- Triggered by negative feedback pattern
  )),

  -- Scope
  interactions_analyzed INTEGER DEFAULT 0,
  date_range_start TIMESTAMP WITH TIME ZONE,
  date_range_end TIMESTAMP WITH TIME ZONE,

  -- Results
  suggestions_generated INTEGER DEFAULT 0,
  patterns_found JSONB,
  summary TEXT,

  -- Execution
  status TEXT DEFAULT 'running' CHECK (status IN (
    'running',
    'completed',
    'failed'
  )),
  error_message TEXT,

  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Cost tracking
  model_used TEXT,
  tokens_used INTEGER
);

-- =====================================================
-- UPDATES TO ADDIE_INTERACTIONS
-- =====================================================
-- Add rating and context fields for learning

ALTER TABLE addie_interactions
  ADD COLUMN IF NOT EXISTS rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  ADD COLUMN IF NOT EXISTS rating_by TEXT,
  ADD COLUMN IF NOT EXISTS rating_notes TEXT,
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN (
    'resolved',        -- User's question/need was addressed
    'partially_resolved',
    'unresolved',
    'escalated',       -- Needed human help
    'unknown'
  )),
  ADD COLUMN IF NOT EXISTS user_sentiment TEXT CHECK (user_sentiment IN (
    'positive',
    'neutral',
    'negative',
    'unknown'
  )),
  ADD COLUMN IF NOT EXISTS intent_category TEXT,  -- Categorization of what user wanted
  ADD COLUMN IF NOT EXISTS active_rules_snapshot JSONB,  -- Rules active at time of interaction
  ADD COLUMN IF NOT EXISTS experiment_id INTEGER REFERENCES addie_experiments(id),
  ADD COLUMN IF NOT EXISTS experiment_group TEXT CHECK (experiment_group IN ('control', 'variant'));

-- Index for analysis queries
CREATE INDEX IF NOT EXISTS idx_addie_interactions_rating ON addie_interactions(rating) WHERE rating IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_addie_interactions_outcome ON addie_interactions(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_addie_interactions_experiment ON addie_interactions(experiment_id) WHERE experiment_id IS NOT NULL;

-- =====================================================
-- SEED INITIAL RULES
-- =====================================================
-- Start with Addie's current behavior as version 1 rules

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'system_prompt',
  'Core Identity',
  'Addie''s fundamental identity and purpose',
  'You are Addie, the helpful AI assistant for the AAO (Agentic Advertising Organization) community. You are knowledgeable about AdCP (Advertising Context Protocol), agentic advertising, and the broader advertising technology ecosystem.

Your personality:
- Friendly and approachable
- Knowledgeable but humble
- Concise but thorough when needed
- A good connector of people and ideas',
  100,
  'system'
),
(
  'behavior',
  'Knowledge Search First',
  'Always search knowledge base before answering',
  'When asked a question about AdCP, agentic advertising, or AAO:
1. First use search_knowledge to find relevant information
2. If results are found, use get_knowledge to read the full content
3. Base your answer on the knowledge base content
4. Cite your sources when possible',
  90,
  'system'
),
(
  'behavior',
  'Uncertainty Acknowledgment',
  'Be honest about limitations',
  'When you don''t have enough information to answer confidently:
- Say "I''m not sure about that" or "I don''t have specific information on that"
- Suggest where the user might find the answer
- Offer to help with related questions you CAN answer
- Never make up information',
  80,
  'system'
),
(
  'constraint',
  'No Hallucination',
  'Prevent making up facts',
  'NEVER:
- Invent facts about AdCP or AAO
- Make up names of people, companies, or projects
- Claim capabilities that don''t exist
- Provide specific numbers or dates unless from knowledge base',
  95,
  'system'
),
(
  'response_style',
  'Slack Formatting',
  'Format responses for Slack',
  'Format your responses for Slack:
- Use *bold* for emphasis (not markdown **)
- Use bullet points for lists
- Keep responses concise - prefer shorter answers
- Use code blocks for technical content
- Break up long responses with line breaks',
  70,
  'system'
)
ON CONFLICT DO NOTHING;
