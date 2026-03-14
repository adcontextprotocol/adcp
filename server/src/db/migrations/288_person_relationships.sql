-- Person Relationships
-- Replaces goal-based outreach with a unified relationship model.
-- One row per person, linking all identities, tracking the ongoing relationship.

-- ─── Core table ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS person_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity links (at least one must be set)
  slack_user_id VARCHAR(255) UNIQUE,
  workos_user_id VARCHAR(255) UNIQUE,
  email VARCHAR(255),
  prospect_org_id VARCHAR(255) REFERENCES organizations(workos_organization_id),

  -- Display
  display_name VARCHAR(255),

  -- Journey stage
  stage VARCHAR(50) NOT NULL DEFAULT 'prospect'
    CHECK (stage IN ('prospect', 'welcomed', 'exploring', 'participating', 'contributing', 'leading')),
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Engagement state
  last_addie_message_at TIMESTAMPTZ,
  last_person_message_at TIMESTAMPTZ,
  last_interaction_channel VARCHAR(50),
  next_contact_after TIMESTAMPTZ,
  contact_preference VARCHAR(50) CHECK (contact_preference IN ('slack', 'email') OR contact_preference IS NULL),

  -- Slack DM state (single thread model)
  slack_dm_channel_id VARCHAR(255),
  slack_dm_thread_ts VARCHAR(255),

  -- Relationship quality
  sentiment_trend VARCHAR(20) DEFAULT 'neutral'
    CHECK (sentiment_trend IN ('positive', 'neutral', 'negative', 'disengaging')),
  interaction_count INTEGER NOT NULL DEFAULT 0,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- At least one identity must be set
  CONSTRAINT person_has_identity CHECK (
    slack_user_id IS NOT NULL
    OR workos_user_id IS NOT NULL
    OR email IS NOT NULL
    OR prospect_org_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_person_relationships_stage
  ON person_relationships(stage);

CREATE INDEX IF NOT EXISTS idx_person_relationships_next_contact
  ON person_relationships(next_contact_after)
  WHERE opted_out = FALSE AND next_contact_after IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_person_relationships_slack
  ON person_relationships(slack_user_id)
  WHERE slack_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_person_relationships_workos
  ON person_relationships(workos_user_id)
  WHERE workos_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_relationships_email_unique
  ON person_relationships(email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_person_relationships_prospect_org
  ON person_relationships(prospect_org_id)
  WHERE prospect_org_id IS NOT NULL;

-- ─── Link threads to relationships ──────────────────────────────────────────

ALTER TABLE addie_threads
  ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES person_relationships(id);

CREATE INDEX IF NOT EXISTS idx_addie_threads_person
  ON addie_threads(person_id)
  WHERE person_id IS NOT NULL;

-- ─── Backfill from slack_user_mappings ──────────────────────────────────────
-- Every non-bot, non-deleted Slack user gets a relationship record.

INSERT INTO person_relationships (
  slack_user_id,
  workos_user_id,
  email,
  display_name,
  stage,
  stage_changed_at,
  last_addie_message_at,
  opted_out,
  created_at
)
SELECT
  sm.slack_user_id,
  sm.workos_user_id,
  sm.slack_email,
  COALESCE(sm.slack_display_name, sm.slack_real_name),
  -- Calculate initial stage from existing data
  CASE
    -- Committee leaders or council members
    WHEN EXISTS (
      SELECT 1 FROM working_group_leaders wgl WHERE wgl.user_id = sm.slack_user_id
    ) OR EXISTS (
      SELECT 1 FROM working_group_leaders wgl WHERE wgl.user_id = sm.workos_user_id
    ) THEN 'leading'
    -- In working groups with decent activity
    WHEN sm.workos_user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM working_group_memberships wgm
      WHERE wgm.workos_user_id = sm.workos_user_id AND wgm.status = 'active'
    ) THEN 'participating'
    -- Has account linked (website user)
    WHEN sm.workos_user_id IS NOT NULL THEN 'exploring'
    -- Addie has messaged them before
    WHEN sm.last_outreach_at IS NOT NULL THEN 'welcomed'
    -- Never contacted
    ELSE 'prospect'
  END,
  COALESCE(sm.last_outreach_at, sm.created_at),
  COALESCE(sm.outreach_opt_out, FALSE),
  sm.created_at
FROM slack_user_mappings sm
WHERE sm.slack_is_bot = FALSE
  AND sm.slack_is_deleted = FALSE
ON CONFLICT (slack_user_id) DO NOTHING;

-- ─── Backfill from email-only prospects ─────────────────────────────────────
-- Addie-owned prospects with contact email who aren't in Slack.

INSERT INTO person_relationships (
  email,
  prospect_org_id,
  display_name,
  stage,
  stage_changed_at,
  last_addie_message_at,
  created_at
)
SELECT
  o.prospect_contact_email,
  o.workos_organization_id,
  COALESCE(o.prospect_contact_name, o.name),
  CASE
    WHEN o.last_email_outreach_at IS NOT NULL THEN 'welcomed'
    ELSE 'prospect'
  END,
  COALESCE(o.last_email_outreach_at, o.created_at),
  o.last_email_outreach_at,
  o.created_at
FROM organizations o
WHERE o.prospect_owner = 'addie'
  AND o.prospect_contact_email IS NOT NULL
  AND o.subscription_status IS NULL
  -- Skip if this person's email already exists via Slack backfill
  AND NOT EXISTS (
    SELECT 1 FROM person_relationships pr
    WHERE pr.email = o.prospect_contact_email
  )
  -- Skip if this org is already linked via Slack backfill
  AND NOT EXISTS (
    SELECT 1 FROM person_relationships pr
    WHERE pr.prospect_org_id = o.workos_organization_id
  )
ON CONFLICT DO NOTHING;

-- ─── Link existing threads to relationships ─────────────────────────────────
-- Match threads to relationship records by user_id.

UPDATE addie_threads t
SET person_id = pr.id
FROM person_relationships pr
WHERE t.person_id IS NULL
  AND (
    (t.user_type = 'slack' AND t.user_id = pr.slack_user_id)
    OR (t.user_type = 'workos' AND t.user_id = pr.workos_user_id)
  );

-- ─── Backfill permanent Slack DM thread coordinates ─────────────────────────
-- Find the earliest DM thread for each person and save it as the permanent thread.

UPDATE person_relationships pr
SET
  slack_dm_channel_id = sub.channel_id,
  slack_dm_thread_ts = sub.thread_ts
FROM (
  SELECT DISTINCT ON (t.person_id)
    t.person_id,
    split_part(t.external_id, ':', 1) AS channel_id,
    split_part(t.external_id, ':', 2) AS thread_ts
  FROM addie_threads t
  WHERE t.person_id IS NOT NULL
    AND t.channel = 'slack'
    AND t.external_id LIKE 'D%:%'  -- DM channels start with D
  ORDER BY t.person_id, t.started_at ASC
) sub
WHERE pr.id = sub.person_id
  AND pr.slack_dm_thread_ts IS NULL;

-- ─── Backfill interaction counts ────────────────────────────────────────────

UPDATE person_relationships pr
SET interaction_count = sub.msg_count
FROM (
  SELECT t.person_id, SUM(t.message_count) AS msg_count
  FROM addie_threads t
  WHERE t.person_id IS NOT NULL
  GROUP BY t.person_id
) sub
WHERE pr.id = sub.person_id;

-- ─── Backfill last_person_message_at from thread messages ───────────────────

UPDATE person_relationships pr
SET last_person_message_at = sub.last_msg
FROM (
  SELECT t.person_id, MAX(m.created_at) AS last_msg
  FROM addie_thread_messages m
  JOIN addie_threads t ON t.thread_id = m.thread_id
  WHERE t.person_id IS NOT NULL
    AND m.role = 'user'
  GROUP BY t.person_id
) sub
WHERE pr.id = sub.person_id;
