-- NOTE: migrations 433_auto_provision_verified_domain.sql and
-- 433_catalog_adagents_lookup_index.sql both use number 433.
-- This migration is numbered 434 to avoid a second collision.
-- The pre-existing 433 duplication should be resolved separately.

CREATE TABLE agent_test_runs (
  id              BIGSERIAL    PRIMARY KEY,
  workos_user_id  TEXT         NOT NULL,
  workos_organization_id TEXT,
  agent_hostname  TEXT,
  agent_protocol  TEXT         CHECK (agent_protocol IS NULL OR agent_protocol IN ('mcp', 'a2a', 'rest')),
  test_kind       TEXT         NOT NULL,
  outcome         TEXT         NOT NULL CHECK (outcome IN ('pass', 'fail', 'partial', 'error')),
  duration_ms     INTEGER      NOT NULL DEFAULT -1,
  storyboard_id   TEXT,
  ran_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_agent_test_runs_user_ran_at ON agent_test_runs (workos_user_id, ran_at DESC);
CREATE INDEX idx_agent_test_runs_org_ran_at  ON agent_test_runs (workos_organization_id, ran_at DESC)
  WHERE workos_organization_id IS NOT NULL;
