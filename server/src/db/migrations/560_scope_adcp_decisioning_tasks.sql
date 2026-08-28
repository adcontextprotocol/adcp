-- Expand the decisioning task registry for SDK 14.0.0-beta.13 without
-- changing the beta.12 table underneath a rolling deployment. The old table
-- has neither hosted-tenant nor authenticated-owner identity, so its rows
-- cannot be copied safely into an active scoped namespace.

CREATE TABLE IF NOT EXISTS adcp_decisioning_tasks_v2 (
  registry_namespace TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  tool            TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  owner_scope     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'submitted',
  status_message  TEXT,
  result          JSONB,
  error           JSONB,
  progress        JSONB,
  has_webhook     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT adcp_decisioning_tasks_v2_valid_status CHECK (
    status IN ('submitted', 'working', 'completed', 'failed')
  ),
  CONSTRAINT adcp_decisioning_tasks_v2_scope_pkey
    PRIMARY KEY (registry_namespace, account_id, owner_scope, task_id)
);

CREATE INDEX IF NOT EXISTS idx_adcp_decisioning_tasks_v2_account_id
  ON adcp_decisioning_tasks_v2(account_id);

CREATE INDEX IF NOT EXISTS idx_adcp_decisioning_tasks_v2_status_created
  ON adcp_decisioning_tasks_v2(status, created_at);

CREATE INDEX IF NOT EXISTS idx_adcp_decisioning_tasks_v2_owner_account
  ON adcp_decisioning_tasks_v2(owner_scope, account_id);

-- A release migration runs while beta.12 machines are still serving. Lock the
-- legacy table across the active-task check and trigger installation so an old
-- writer cannot create an unpollable task between them. Once this commits,
-- beta.12 machines fail closed for new async handoffs until the rolling deploy
-- replaces them; their existing synchronous tools remain available.
LOCK TABLE adcp_decisioning_tasks IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM adcp_decisioning_tasks
    WHERE status IN ('submitted', 'working')
  ) THEN
    RAISE EXCEPTION
      'Drain active decisioning tasks before enabling the scoped task registry';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_legacy_adcp_decisioning_task_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Legacy decisioning task writes are disabled during the scoped-registry rollout';
END;
$$;

DROP TRIGGER IF EXISTS reject_legacy_adcp_decisioning_task_insert
  ON adcp_decisioning_tasks;

CREATE TRIGGER reject_legacy_adcp_decisioning_task_insert
  BEFORE INSERT ON adcp_decisioning_tasks
  FOR EACH ROW
  EXECUTE FUNCTION reject_legacy_adcp_decisioning_task_insert();
