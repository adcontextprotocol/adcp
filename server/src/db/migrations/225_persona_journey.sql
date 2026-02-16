-- Migration: 206_persona_journey.sql
-- Add persona classification and journey stage tracking to organizations.
--
-- Persona: Which of the 5 behavioral personas this org matches (org-level).
-- Journey stage: Where they are in the member lifecycle (milestone-based, can regress).
-- Journey history: Full log of stage transitions for trajectory analysis.
--
-- Both fields are also tracked in org_knowledge for provenance. These columns
-- are materialized views for fast reads.

-- =====================================================
-- PERSONA & JOURNEY COLUMNS ON ORGANIZATIONS
-- =====================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS persona VARCHAR(50)
    CHECK (persona IS NULL OR persona IN (
      'molecule_builder', 'data_decoder', 'pureblood_protector',
      'resops_integrator', 'ladder_climber', 'simple_starter'
    )),
  ADD COLUMN IF NOT EXISTS aspiration_persona VARCHAR(50)
    CHECK (aspiration_persona IS NULL OR aspiration_persona IN (
      'molecule_builder', 'data_decoder', 'pureblood_protector',
      'resops_integrator', 'ladder_climber', 'simple_starter'
    )),
  ADD COLUMN IF NOT EXISTS persona_source VARCHAR(50)
    CHECK (persona_source IS NULL OR persona_source IN (
      'user_reported', 'admin_set', 'diagnostic', 'enrichment', 'addie_inferred'
    )),
  ADD COLUMN IF NOT EXISTS persona_set_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS journey_stage VARCHAR(50)
    CHECK (journey_stage IS NULL OR journey_stage IN (
      'aware', 'evaluating', 'joined', 'onboarding',
      'participating', 'contributing', 'leading', 'advocating'
    )),
  ADD COLUMN IF NOT EXISTS journey_stage_set_at TIMESTAMP WITH TIME ZONE;

-- Indexes for filtering/grouping by persona and journey stage
CREATE INDEX IF NOT EXISTS idx_organizations_persona
  ON organizations(persona) WHERE persona IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_journey_stage
  ON organizations(journey_stage) WHERE journey_stage IS NOT NULL;

-- =====================================================
-- JOURNEY STAGE HISTORY TABLE
-- =====================================================
-- Tracks every transition so we can see the full trajectory,
-- including regressions (e.g., Leading -> Participating after a chair leaves).

CREATE TABLE IF NOT EXISTS journey_stage_history (
  id SERIAL PRIMARY KEY,

  workos_organization_id VARCHAR(255) NOT NULL
    REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- The transition
  from_stage VARCHAR(50)                    -- NULL for initial assignment
    CHECK (from_stage IS NULL OR from_stage IN (
      'aware', 'evaluating', 'joined', 'onboarding',
      'participating', 'contributing', 'leading', 'advocating'
    )),
  to_stage VARCHAR(50) NOT NULL
    CHECK (to_stage IN (
      'aware', 'evaluating', 'joined', 'onboarding',
      'participating', 'contributing', 'leading', 'advocating'
    )),

  -- What triggered it
  trigger_type VARCHAR(50) NOT NULL
    CHECK (trigger_type IN (
      'milestone_achieved',                 -- Normal forward progression
      'milestone_lost',                     -- Regression due to lost milestone
      'admin_override',                     -- Manual adjustment by admin
      'recomputation',                      -- Periodic recalculation
      'initial'                             -- First-time assignment
    )),
  trigger_detail TEXT,                      -- e.g., 'joined working group: Media Buying Protocol'

  -- Who/what caused it
  triggered_by VARCHAR(255),                -- WorkOS user ID, 'system', or 'addie'

  -- Timestamp
  transitioned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_journey_history_org
  ON journey_stage_history(workos_organization_id, transitioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_journey_history_stage
  ON journey_stage_history(to_stage, transitioned_at DESC);

-- =====================================================
-- PERSONA-COUNCIL AFFINITY TABLE
-- =====================================================
-- Maps which working groups and councils appeal to which personas.
-- Based on the JourneySpark appeal matrix (slide 6).

CREATE TABLE IF NOT EXISTS persona_group_affinity (
  id SERIAL PRIMARY KEY,

  persona VARCHAR(50) NOT NULL
    CHECK (persona IN (
      'molecule_builder', 'data_decoder', 'pureblood_protector',
      'resops_integrator', 'ladder_climber', 'simple_starter'
    )),
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- How strong the affinity is (1-5, higher = more appeal)
  affinity_score INTEGER NOT NULL DEFAULT 3
    CHECK (affinity_score BETWEEN 1 AND 5),

  UNIQUE(persona, working_group_id)
);

CREATE INDEX IF NOT EXISTS idx_persona_affinity_persona
  ON persona_group_affinity(persona);
CREATE INDEX IF NOT EXISTS idx_persona_affinity_group
  ON persona_group_affinity(working_group_id);

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON COLUMN organizations.persona IS 'Behavioral persona classification (org-level center of gravity)';
COMMENT ON COLUMN organizations.aspiration_persona IS 'Where the org aspires to be (may differ from current persona)';
COMMENT ON COLUMN organizations.persona_source IS 'How persona was determined: diagnostic (self-id), admin_set, or addie_inferred';
COMMENT ON COLUMN organizations.journey_stage IS 'Current milestone-based journey stage. Can regress unlike engagement scores.';

COMMENT ON TABLE journey_stage_history IS 'Full log of journey stage transitions per org, including regressions';
COMMENT ON COLUMN journey_stage_history.trigger_type IS 'What caused this transition: milestone_achieved, milestone_lost, admin_override, recomputation, initial';

COMMENT ON TABLE persona_group_affinity IS 'Maps persona affinity to working groups/councils. Used by Addie for recommendations.';
