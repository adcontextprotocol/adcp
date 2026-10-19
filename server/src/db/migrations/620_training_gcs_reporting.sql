-- SDK 15.2.0 production composer SQL, plus Core writer fence and GCS authority.
-- An isolated schema on the SAME primary; never attach a writable clone to live objects.
-- A DBA provisions this schema for the ordinary application role before deployment.
-- Do not require database-wide CREATE or an operator credential in the runtime.
DO $schema_precondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'training_reporting_gcs') THEN
    RAISE EXCEPTION 'Provision training_reporting_gcs for the application role before migration 620';
  END IF;
  IF NOT has_schema_privilege(current_user, 'training_reporting_gcs', 'USAGE')
    OR NOT has_schema_privilege(current_user, 'training_reporting_gcs', 'CREATE') THEN
    RAISE EXCEPTION 'Application role requires USAGE and CREATE on training_reporting_gcs';
  END IF;
END;
$schema_precondition$;
SET LOCAL search_path = training_reporting_gcs, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS adcp_reporting_configurations (
  configuration_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  delivery_config_id TEXT NOT NULL,
  delivery_config_version INTEGER NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, delivery_config_id, delivery_config_version)
);

CREATE TABLE IF NOT EXISTS adcp_reporting_obligations (
  obligation_id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL REFERENCES adcp_reporting_configurations(configuration_id),
  account_id TEXT NOT NULL,
  period_ordinal BIGINT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  UNIQUE (configuration_id, period_ordinal),
  CHECK (period_start < period_end),
  CHECK (state IN ('pending', 'terminal'))
);

ALTER TABLE adcp_reporting_obligations ADD COLUMN IF NOT EXISTS period_ordinal BIGINT;
UPDATE adcp_reporting_obligations
  SET period_ordinal = (data->>'periodOrdinal')::bigint
  WHERE period_ordinal IS NULL AND data->>'periodOrdinal' ~ '^-?[0-9]+$';
ALTER TABLE adcp_reporting_obligations ALTER COLUMN period_ordinal SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_obligations_configuration_ordinal
  ON adcp_reporting_obligations (configuration_id, period_ordinal);

CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_due
  ON adcp_reporting_obligations (next_attempt_at, obligation_id)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_account_due
  ON adcp_reporting_obligations (account_id, next_attempt_at, obligation_id)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_account_period
  ON adcp_reporting_obligations (account_id, period_start, obligation_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_changed
  ON adcp_reporting_obligations (account_id, changed_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_revisions (
  revision_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  revision_number INTEGER NOT NULL,
  finality TEXT NOT NULL,
  kind TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES adcp_reporting_revisions(revision_id),
  content_sha256 TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (obligation_id, revision_number),
  CHECK (finality IN ('snapshot', 'official')),
  CHECK (kind IN ('snapshot', 'official'))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_revisions_obligation
  ON adcp_reporting_revisions (obligation_id, revision_number);
CREATE INDEX IF NOT EXISTS adcp_reporting_revisions_created
  ON adcp_reporting_revisions (obligation_id, recorded_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  adjusts_revision_id TEXT NOT NULL REFERENCES adcp_reporting_revisions(revision_id),
  adjustment_number INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (obligation_id, adjustment_number)
);
CREATE INDEX IF NOT EXISTS adcp_reporting_adjustments_obligation
  ON adcp_reporting_adjustments (obligation_id, adjustment_number);
CREATE INDEX IF NOT EXISTS adcp_reporting_adjustments_created
  ON adcp_reporting_adjustments (obligation_id, recorded_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_consumer_statuses (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  consumer_status_id TEXT NOT NULL,
  chain_key TEXT NOT NULL,
  revision_id TEXT REFERENCES adcp_reporting_revisions(revision_id),
  obligation_id TEXT REFERENCES adcp_reporting_obligations(obligation_id),
  supersedes_consumer_status_id TEXT,
  is_current BOOLEAN NOT NULL DEFAULT true,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, consumer_status_id)
);
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN revision_id DROP NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN obligation_id DROP NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS consumer_id TEXT;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS chain_key TEXT;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS semantic_fingerprint TEXT;
-- Preserve predecessor API rows under a reserved compatibility principal;
-- putConsumerStatus/listConsumerStatuses continue to serve this namespace.
UPDATE adcp_reporting_consumer_statuses AS status
SET account_id = COALESCE(
      status.account_id,
      obligation.data->'account'->>'account_id',
      '__legacy_unscoped_account__'
    ),
    consumer_id = COALESCE(status.consumer_id, '__legacy_unscoped_consumer__'),
    chain_key = COALESCE(status.chain_key, 'legacy:' || status.consumer_status_id),
    semantic_fingerprint = COALESCE(status.semantic_fingerprint, 'legacy:' || status.consumer_status_id)
FROM adcp_reporting_obligations AS obligation
WHERE status.obligation_id = obligation.obligation_id
  AND (status.account_id IS NULL OR status.consumer_id IS NULL OR status.chain_key IS NULL
       OR status.semantic_fingerprint IS NULL);
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN consumer_id SET NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN chain_key SET NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN semantic_fingerprint SET NOT NULL;
DO $migration$
DECLARE self_fk RECORD;
BEGIN
  FOR self_fk IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'adcp_reporting_consumer_statuses'::regclass
      AND confrelid = 'adcp_reporting_consumer_statuses'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE adcp_reporting_consumer_statuses DROP CONSTRAINT %I',
      self_fk.conname
    );
  END LOOP;
END
$migration$;
ALTER TABLE adcp_reporting_consumer_statuses DROP CONSTRAINT IF EXISTS adcp_reporting_consumer_statuses_pkey;
ALTER TABLE adcp_reporting_consumer_statuses
  ADD CONSTRAINT adcp_reporting_consumer_statuses_pkey PRIMARY KEY (account_id, consumer_id, consumer_status_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_consumer_statuses_revision
  ON adcp_reporting_consumer_statuses (revision_id, created_at, consumer_status_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_consumer_statuses_scope
  ON adcp_reporting_consumer_statuses (account_id, consumer_id, created_at, consumer_status_id);
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_consumer_statuses_current
  ON adcp_reporting_consumer_statuses (account_id, consumer_id, chain_key) WHERE is_current;
-- The managed state digest is read inside the apply transaction, under the
-- account lock. Filtering this table by obligation alone matched no index, so
-- every apply scanned every consumer status in the deployment while holding
-- that lock and pushed concurrent Core writes past their lock timeout.
CREATE INDEX IF NOT EXISTS adcp_reporting_consumer_statuses_obligation
  ON adcp_reporting_consumer_statuses (obligation_id, created_at, consumer_status_id);

CREATE TABLE IF NOT EXISTS adcp_reporting_consumer_status_batches (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status_ids JSONB NOT NULL,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, idempotency_key)
);
ALTER TABLE adcp_reporting_consumer_status_batches ADD COLUMN IF NOT EXISTS results JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS adcp_reporting_issues (
  issue_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  data JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS adcp_reporting_issues_obligation
  ON adcp_reporting_issues (obligation_id, observed_at, issue_id);

-- Per-obligation reconciliation watermark. A reconcile that changes nothing
-- still has to record that it looked, or a change with no health effect stays
-- a candidate forever and starves newer work behind it. Core, not managed:
-- the lifecycle sweep is a Core concern and must not depend on the add-on.
CREATE TABLE IF NOT EXISTS adcp_reporting_lifecycle_state (
  obligation_id TEXT PRIMARY KEY REFERENCES adcp_reporting_obligations(obligation_id),
  processed_state_version TEXT,
  processed_roster_version TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS adcp_reporting_lifecycle_state_processed
  ON adcp_reporting_lifecycle_state (processed_at, obligation_id);
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS current_roster_version TEXT;
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS roster_refreshed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS adcp_reporting_lifecycle_state_roster_refreshed
  ON adcp_reporting_lifecycle_state (roster_refreshed_at, obligation_id);

CREATE TABLE IF NOT EXISTS adcp_reporting_transitions (
  transition_id TEXT PRIMARY KEY,
  transition_sequence BIGSERIAL NOT NULL UNIQUE,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  data JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS adcp_reporting_transitions_obligation
  ON adcp_reporting_transitions (obligation_id, occurred_at, transition_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_transitions_pending
  ON adcp_reporting_transitions (recorded_at, transition_id)
  WHERE NOT (data ? 'notifiedAt');

CREATE TABLE IF NOT EXISTS adcp_reporting_snapshots (
  snapshot_id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  query_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  byte_count BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS adcp_reporting_snapshots_created
  ON adcp_reporting_snapshots (created_at);
CREATE INDEX IF NOT EXISTS adcp_reporting_snapshots_expiry
  ON adcp_reporting_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_checkpoints (
  checkpoint_id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  ledger_as_of TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS adcp_reporting_checkpoints_expiry
  ON adcp_reporting_checkpoints (expires_at);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'adcp_reporting_transitions'::regclass
       AND conname = 'adcp_reporting_transitions_finality_recorded'
  ) THEN
    ALTER TABLE adcp_reporting_transitions
      ADD CONSTRAINT adcp_reporting_transitions_finality_recorded
      CHECK (data ? 'finality') NOT VALID;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS adcp_reporting_destination_authorizations (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  cleanup_completed_at TIMESTAMPTZ,
  cleanup_lease_owner TEXT,
  cleanup_lease_generation BIGINT NOT NULL DEFAULT 0,
  cleanup_lease_expires_at TIMESTAMPTZ,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  data JSONB NOT NULL,
  PRIMARY KEY (account_id, destination_ref, generation),
  CHECK (generation > 0),
  CHECK (revoked_at IS NULL OR revoked_at >= authorized_at)
);
ALTER TABLE adcp_reporting_destination_authorizations
  ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_destination_authorizations_current
  ON adcp_reporting_destination_authorizations (account_id, destination_ref)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_destination_authorizations_cleanup
  ON adcp_reporting_destination_authorizations (revoked_at, account_id, destination_ref)
  WHERE revoked_at IS NOT NULL AND cleanup_completed_at IS NULL;

CREATE TABLE IF NOT EXISTS adcp_reporting_managed_bindings (
  configuration_id TEXT PRIMARY KEY REFERENCES adcp_reporting_configurations(configuration_id),
  account_id TEXT NOT NULL,
  delivery_config_id TEXT NOT NULL,
  delivery_config_version INTEGER NOT NULL,
  destination_ref TEXT NOT NULL,
  authorization_generation BIGINT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (account_id, destination_ref, authorization_generation)
    REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation),
  UNIQUE (account_id, delivery_config_id, delivery_config_version)
);

CREATE TABLE IF NOT EXISTS adcp_reporting_materializations (
  materialization_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL REFERENCES adcp_reporting_managed_bindings(configuration_id),
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  revision_id TEXT NOT NULL REFERENCES adcp_reporting_revisions(revision_id),
  destination_ref TEXT NOT NULL,
  authorization_generation BIGINT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  UNIQUE (configuration_id, revision_id, attempt),
  CHECK (attempt > 0),
  CHECK (status IN ('pending', 'available', 'delivered', 'failed'))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_materializations_claim
  ON adcp_reporting_materializations (created_at, materialization_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS adcp_reporting_materializations_obligation
  ON adcp_reporting_materializations (obligation_id, recorded_at, materialization_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_materializations_account_retention
  ON adcp_reporting_materializations (account_id, recorded_at);
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_materializations_success
  ON adcp_reporting_materializations (configuration_id, revision_id)
  WHERE status IN ('available', 'delivered');

CREATE TABLE IF NOT EXISTS adcp_reporting_receipts (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  reporting_receipt_id TEXT NOT NULL,
  receipt_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  supersedes_receipt_id TEXT,
  is_current BOOLEAN NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, reporting_receipt_id),
  CHECK (receipt_kind IN ('revision', 'adjustment'))
);
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_receipts_current
  ON adcp_reporting_receipts (account_id, consumer_id, receipt_kind, subject_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS adcp_reporting_receipts_readback
  ON adcp_reporting_receipts (account_id, consumer_id, recorded_at, reporting_receipt_id);
-- The as-of-cutoff leaf asks, per candidate, whether anything recorded by the
-- cutoff supersedes it. Without this that question is a scan of the caller's
-- whole receipt history.
CREATE INDEX IF NOT EXISTS adcp_reporting_receipts_supersedes
  ON adcp_reporting_receipts (account_id, consumer_id, supersedes_receipt_id)
  WHERE supersedes_receipt_id IS NOT NULL;
-- Every lifecycle read is "the receipts for this obligation's subjects". The
-- receipt table is global and its other indexes lead with account and
-- consumer, neither of which that question supplies, so each due obligation
-- re-scanned the whole receipt history.
CREATE INDEX IF NOT EXISTS adcp_reporting_receipts_subject
  ON adcp_reporting_receipts (subject_id, receipt_kind, recorded_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_receipt_batches (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  results JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, idempotency_key)
);
-- Pruning used to ask "does any live replay row contain this receipt id" per
-- candidate, which no index could serve for a correlated operand. It now
-- expands the account's replay rows once instead, so no GIN index is needed
-- and the batches table is not burdened with maintaining one.

-- Agent-wide promises, durable and shared by every store instance and process
-- that talks to this database. An in-memory bound only constrains the process
-- that set it, so two replicas could each believe they were authoritative and
-- publish different windows over the same bindings.
CREATE TABLE IF NOT EXISTS adcp_reporting_managed_policy (
  policy_key TEXT PRIMARY KEY,
  advertised_recovery_window_seconds BIGINT,
  advertised_status_retention_days BIGINT,
  advertised_resource_retention_days BIGINT,
  advertised_authorization_revocation_seconds BIGINT,
  materialization_planning_cursor TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- Upgrade registries installed by earlier Managed Delivery release candidates.
ALTER TABLE adcp_reporting_managed_policy
  ADD COLUMN IF NOT EXISTS advertised_resource_retention_days BIGINT;
ALTER TABLE adcp_reporting_managed_policy
  ADD COLUMN IF NOT EXISTS advertised_authorization_revocation_seconds BIGINT;
-- Durable round-robin position for deployment-wide materialization planning.
-- A process-local cursor restarts at the lexically first tenant after every
-- deploy; without a durable position a continuously busy first account can
-- consume every bounded planning page and a later account never progresses.
ALTER TABLE adcp_reporting_managed_policy
  ADD COLUMN IF NOT EXISTS materialization_planning_cursor TEXT;
-- Every policy read or adoption locks this durable row. Creating it in the
-- migration avoids a missing-row predicate gap on a fresh registry.
INSERT INTO adcp_reporting_managed_policy (policy_key)
VALUES ('agent')
ON CONFLICT (policy_key) DO NOTHING;

-- Permanent, compact identity for a receipt whose body has aged out.
-- Bodies are retained only through the advertised horizon, but identity is
-- forever: a pruned receipt_id must never bind different content later, and a
-- subject that reached a terminal accepted leaf must never reopen because the
-- row proving it was terminal has expired.
CREATE TABLE IF NOT EXISTS adcp_reporting_receipt_tombstones (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  reporting_receipt_id TEXT NOT NULL,
  receipt_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  was_current BOOLEAN NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  pruned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, reporting_receipt_id)
);
-- When the pruned receipt itself was recorded, and what it superseded. A
-- tombstone without them is a conclusion with no place in time: a historical
-- projection applied an acceptance that had not happened yet at its cutoff,
-- and a chain whose successor was pruned let the predecessor it superseded
-- come back as the live leaf. Nullable for rows written before this column
-- existed; readers fall back to pruned_at, which is never earlier.
ALTER TABLE adcp_reporting_receipt_tombstones
  ADD COLUMN IF NOT EXISTS subject_recorded_at TIMESTAMPTZ;
ALTER TABLE adcp_reporting_receipt_tombstones
  ADD COLUMN IF NOT EXISTS supersedes_receipt_id TEXT;
CREATE INDEX IF NOT EXISTS adcp_reporting_receipt_tombstones_supersedes
  ON adcp_reporting_receipt_tombstones (account_id, consumer_id, supersedes_receipt_id)
  WHERE supersedes_receipt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_receipt_tombstones_subject
  ON adcp_reporting_receipt_tombstones (account_id, consumer_id, receipt_kind, subject_id);

-- Compact terminal state for a materialization whose row has been pruned.
-- Attempt history is control state, not evidence: without it a revision whose
-- attempts were exhausted, or which already succeeded, restarts at attempt 1
-- the moment its rows age out.
CREATE TABLE IF NOT EXISTS adcp_reporting_materialization_tombstones (
  configuration_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  highest_attempt INTEGER NOT NULL,
  reached_success BOOLEAN NOT NULL,
  pruned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- When the delivery this records actually succeeded, so a projection at an
  -- earlier cutoff does not read it as already delivered.
  reached_success_at TIMESTAMPTZ,
  PRIMARY KEY (configuration_id, revision_id)
);
-- These rows are permanent and every lifecycle projection reads them by
-- obligation and success. The primary key leads with configuration, which
-- that question does not supply, so the scan grew without bound for the life
-- of the deployment.
CREATE INDEX IF NOT EXISTS adcp_reporting_materialization_tombstones_obligation
  ON adcp_reporting_materialization_tombstones (obligation_id, reached_success, reached_success_at);


ALTER TABLE adcp_reporting_destination_authorizations
  ADD COLUMN IF NOT EXISTS cleanup_lease_issued_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS "adcp_notification_subscriptions" (
  tenant_scope        TEXT NOT NULL,
  principal_id       TEXT NOT NULL,
  anchor_kind        TEXT NOT NULL CHECK (anchor_kind IN ('caller','account')),
  account_id         TEXT NOT NULL DEFAULT '',
  generation         TEXT NOT NULL,
  subscriptions      JSONB NOT NULL,
  content_fingerprint TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_scope, principal_id, anchor_kind, account_id),
  CONSTRAINT adcp_notification_subscriptions_account_anchor CHECK (
    (anchor_kind = 'caller' AND account_id = '') OR
    (anchor_kind = 'account' AND account_id <> '')
  ),
  CONSTRAINT adcp_notification_subscriptions_subscriptions_array CHECK (jsonb_typeof(subscriptions) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_adcp_notification_subscriptions_account_fanout
  ON "adcp_notification_subscriptions"(tenant_scope, account_id, principal_id) WHERE anchor_kind = 'account';
CREATE INDEX IF NOT EXISTS idx_adcp_notification_subscriptions_caller_fanout
  ON "adcp_notification_subscriptions"(tenant_scope, principal_id) WHERE anchor_kind = 'caller';
CREATE TABLE IF NOT EXISTS "adcp_webhook_deliveries" (
  publisher_scope     TEXT NOT NULL,
  tenant_scope        TEXT NOT NULL,
  delivery_id         TEXT NOT NULL,
  status              TEXT NOT NULL,
  idempotency_key     TEXT,
  payload_fingerprint TEXT,
  first_attempt_at    TIMESTAMPTZ,
  retain_until        TIMESTAMPTZ,
  PRIMARY KEY (publisher_scope, tenant_scope, delivery_id),
  CONSTRAINT adcp_webhook_deliveries_valid_status CHECK (status IN ('bound', 'retired')),
  CONSTRAINT adcp_webhook_deliveries_bound_fields CHECK (
    status = 'retired' OR
    (idempotency_key IS NOT NULL AND payload_fingerprint IS NOT NULL AND
     first_attempt_at IS NOT NULL AND retain_until IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_adcp_webhook_deliveries_retain_until
  ON "adcp_webhook_deliveries"(retain_until) WHERE status = 'bound';
CREATE TABLE IF NOT EXISTS "adcp_webhook_outbox" (
  publisher_scope     TEXT NOT NULL,
  tenant_scope        TEXT NOT NULL,
  delivery_id         TEXT NOT NULL,
  snapshot            JSONB NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  storage_fingerprint  TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending',
  disposition         TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner         TEXT,
  lease_claim_id      TEXT,
  lease_version       BIGINT NOT NULL DEFAULT 0,
  lease_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at          TIMESTAMPTZ,
  PRIMARY KEY (publisher_scope, tenant_scope, delivery_id),
  CONSTRAINT adcp_webhook_outbox_valid_state CHECK (state IN ('pending', 'settled')),
  CONSTRAINT adcp_webhook_outbox_valid_disposition CHECK (disposition IS NULL OR disposition IN ('delivered', 'terminal'))
);

ALTER TABLE "adcp_webhook_outbox"
  ADD COLUMN IF NOT EXISTS intent_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_adcp_webhook_outbox_pending
  ON "adcp_webhook_outbox"(next_attempt_at, lease_expires_at) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS "adcp_reporting_notification_activity" (
  namespace              TEXT NOT NULL,
  transition_id          TEXT NOT NULL,
  activity_sequence      BIGSERIAL NOT NULL UNIQUE,
  tenant_scope           TEXT NOT NULL,
  account_id             TEXT NOT NULL,
  obligation_id          TEXT NOT NULL,
  activity               JSONB NOT NULL,
  intent_fingerprint     TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'pending',
  notification_required  BOOLEAN NOT NULL,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner            TEXT,
  lease_version          BIGINT NOT NULL DEFAULT 0,
  lease_expires_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  projected_at           TIMESTAMPTZ,
  retain_until           TIMESTAMPTZ,
  delivery_intent_at     TIMESTAMPTZ,
  abandoned_at           TIMESTAMPTZ,
  PRIMARY KEY (namespace, transition_id),
  CONSTRAINT adcp_reporting_notification_activity_valid_state CHECK (state IN ('pending', 'projected', 'abandoned')),
  CONSTRAINT adcp_reporting_notification_activity_valid_fingerprint CHECK (intent_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT adcp_reporting_notification_activity_valid_activity CHECK (jsonb_typeof(activity) = 'object'),
  CONSTRAINT adcp_reporting_notification_activity_valid_projection CHECK (
    (state = 'pending' AND notification_required AND projected_at IS NULL AND retain_until IS NULL) OR
    (state = 'projected' AND projected_at IS NOT NULL AND retain_until IS NOT NULL) OR
    -- Abandoned: bounded out of the pending set without ever being recorded as
    -- delivered, so it stops consuming tenant capacity but stays auditable.
    (state = 'abandoned' AND projected_at IS NULL AND retain_until IS NOT NULL AND abandoned_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS "adcp_reporting_notification_activity_cursor" (
  namespace     TEXT PRIMARY KEY,
  tenant_scope TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Upgrade in place, once, and touch nothing on a rerun.
--
-- Every statement here is guarded on the catalog, including the column adds:
-- `ADD COLUMN IF NOT EXISTS` still takes ACCESS EXCLUSIVE to discover the
-- column already exists, so a rerun during normal traffic blocks behind ordinary
-- readers and fails outright under a lock_timeout. An already-upgraded rerun now
-- issues no table-locking statement at all.
--
-- Every guard is scoped to this schema's table by resolving it once to a
-- regclass. A database-wide lookup by index name would see an upgraded index in
-- another schema and skip the upgrade here, leaving that deployment with a
-- projected-only retention index that cannot serve abandonment pruning.
DO $$
DECLARE
  activity_table regclass := to_regclass('adcp_reporting_notification_activity');
  stale_index oid;
BEGIN
  IF activity_table IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = activity_table AND attname = 'delivery_intent_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE "adcp_reporting_notification_activity" ADD COLUMN delivery_intent_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = activity_table AND attname = 'abandoned_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE "adcp_reporting_notification_activity" ADD COLUMN abandoned_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = activity_table AND conname = 'adcp_reporting_notification_activity_valid_state'
       AND pg_get_constraintdef(oid) LIKE '%abandoned%'
  ) THEN
    ALTER TABLE "adcp_reporting_notification_activity" DROP CONSTRAINT IF EXISTS adcp_reporting_notification_activity_valid_state;
    ALTER TABLE "adcp_reporting_notification_activity" ADD CONSTRAINT adcp_reporting_notification_activity_valid_state
      CHECK (state IN ('pending', 'projected', 'abandoned')) NOT VALID;
    ALTER TABLE "adcp_reporting_notification_activity" VALIDATE CONSTRAINT adcp_reporting_notification_activity_valid_state;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = activity_table AND conname = 'adcp_reporting_notification_activity_valid_projection'
       AND pg_get_constraintdef(oid) LIKE '%abandoned_at%'
  ) THEN
    ALTER TABLE "adcp_reporting_notification_activity" DROP CONSTRAINT IF EXISTS adcp_reporting_notification_activity_valid_projection;
    ALTER TABLE "adcp_reporting_notification_activity" ADD CONSTRAINT adcp_reporting_notification_activity_valid_projection CHECK (
      (state = 'pending' AND notification_required AND projected_at IS NULL AND retain_until IS NULL) OR
      (state = 'projected' AND projected_at IS NOT NULL AND retain_until IS NOT NULL) OR
      (state = 'abandoned' AND projected_at IS NULL AND retain_until IS NOT NULL AND abandoned_at IS NOT NULL)
    ) NOT VALID;
    ALTER TABLE "adcp_reporting_notification_activity" VALIDATE CONSTRAINT adcp_reporting_notification_activity_valid_projection;
  END IF;
  SELECT index_class.oid INTO stale_index
    FROM pg_index
    JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
   WHERE pg_index.indrelid = activity_table
     AND index_class.relname = 'idx_adcp_reporting_notification_activity_retention'
     AND pg_get_indexdef(pg_index.indexrelid) NOT LIKE '%abandoned%';
  IF stale_index IS NOT NULL THEN
    EXECUTE format('DROP INDEX %s', stale_index::regclass);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_adcp_reporting_notification_activity_retention'
  ) THEN
    CREATE INDEX idx_adcp_reporting_notification_activity_retention
      ON "adcp_reporting_notification_activity"(namespace, retain_until, activity_sequence)
      WHERE state IN ('projected', 'abandoned');
  END IF;
END $$;

-- One row per frozen recipient, carrying that recipient's own delivery state.
--
-- Relational rather than one serialized document: a document needs a size cap,
-- and a fanout that legitimately exceeded it could never be committed and would
-- retry until it aged out. Only the bounded 64-hex fingerprint enters the index,
-- so an individual recipient reference has no length limit of its own.
--
-- Per-recipient rather than per-emission: attempt_at is the durable pre-POST
-- checkpoint for exactly one recipient, so one recipient's attempt cannot pin a
-- sibling that was suppressed before its own first POST. Rows with no
-- attempt_at are revisable and replaced in place, so a pre-attempt retry can
-- never accumulate superseded state.
--
-- subscriber_key identifies the subscriber independently of its destination
-- generation. Pinning is per subscriber: once a subscriber has been addressed,
-- a later generation of the same subscriber is never addressed for this
-- notification, because that would be the same logical delivery under a new
-- idempotency key. A different subscriber is unaffected.
CREATE TABLE IF NOT EXISTS "adcp_reporting_notification_activity_recipients" (
  namespace              TEXT NOT NULL,
  transition_id          TEXT NOT NULL,
  recipient_fingerprint  TEXT NOT NULL,
  subscriber_key         TEXT NOT NULL,
  recipient              JSONB NOT NULL,
  frozen_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempt_at             TIMESTAMPTZ,
  settled_at             TIMESTAMPTZ,
  disposition            TEXT,
  PRIMARY KEY (namespace, transition_id, recipient_fingerprint),
  CONSTRAINT adcp_reporting_notification_activity_recipients_fk FOREIGN KEY (namespace, transition_id)
    REFERENCES "adcp_reporting_notification_activity"(namespace, transition_id) ON DELETE CASCADE,
  CONSTRAINT adcp_reporting_notification_activity_recipients_fp CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT adcp_reporting_notification_activity_recipients_sk CHECK (subscriber_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT adcp_reporting_notification_activity_recipients_obj CHECK (jsonb_typeof(recipient) = 'object'),
  CONSTRAINT adcp_reporting_notification_activity_recipients_set CHECK (
    (settled_at IS NULL AND disposition IS NULL) OR
    (settled_at IS NOT NULL AND disposition IN ('delivered', 'terminal'))
  )
);
-- Indexes are catalog-guarded too. CREATE INDEX IF NOT EXISTS still takes a
-- ShareLock to discover the index already exists, which conflicts with the
-- RowExclusiveLock every ordinary writer holds — so an already-current rerun
-- would stall live traffic, or fail under a lock_timeout, despite creating
-- nothing. Scoped to this schema's tables by regclass, like every other guard.
DO $$
DECLARE
  activity_table regclass := to_regclass('adcp_reporting_notification_activity');
  recipient_table regclass := to_regclass('adcp_reporting_notification_activity_recipients');
BEGIN
  IF activity_table IS NULL OR recipient_table IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = recipient_table AND index_class.relname = 'idx_adcp_reporting_notification_activity_recipients_unsettled'
  ) THEN
    CREATE INDEX idx_adcp_reporting_notification_activity_recipients_unsettled
      ON "adcp_reporting_notification_activity_recipients"(namespace, transition_id)
      WHERE settled_at IS NULL;
  END IF;
  -- At most one addressed generation per subscriber, enforced by the database.
  --
  -- The checkpoint and a concurrent recipient replacement run as separate
  -- statements against a connection pool, so neither sees the other's
  -- uncommitted work: a freeze can propose a replacement generation while the
  -- original is being checkpointed, and PostgreSQL will keep both rows. This
  -- index is the serialization point. The second generation's checkpoint fails,
  -- so it is never POSTed, and the next freeze drops it because its subscriber
  -- is already claimed. One logical delivery, one idempotency key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = recipient_table
      AND index_class.relname = 'idx_adcp_reporting_notification_activity_recipients_attempted_subscriber'
  ) THEN
    CREATE UNIQUE INDEX idx_adcp_reporting_notification_activity_recipients_attempted_subscriber
      ON "adcp_reporting_notification_activity_recipients"(namespace, transition_id, subscriber_key)
      WHERE attempt_at IS NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_adcp_reporting_notification_activity_pending'
  ) THEN
    CREATE INDEX idx_adcp_reporting_notification_activity_pending
      ON "adcp_reporting_notification_activity"(namespace, next_attempt_at, lease_expires_at, activity_sequence)
      WHERE state = 'pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_adcp_reporting_notification_activity_pending_tenant'
  ) THEN
    CREATE INDEX idx_adcp_reporting_notification_activity_pending_tenant
      ON "adcp_reporting_notification_activity"(namespace, tenant_scope)
      WHERE state = 'pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_adcp_reporting_notification_activity_pending_tenant_due'
  ) THEN
    CREATE INDEX idx_adcp_reporting_notification_activity_pending_tenant_due
      ON "adcp_reporting_notification_activity"(namespace, tenant_scope, next_attempt_at, lease_expires_at)
      WHERE state = 'pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_adcp_reporting_notification_activity_account_activity'
  ) THEN
    CREATE INDEX idx_adcp_reporting_notification_activity_account_activity
      ON "adcp_reporting_notification_activity"(namespace, tenant_scope, account_id, activity_sequence DESC);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS "adcp_reporting_webhook_attempts_metadata" (
  migration_key       TEXT PRIMARY KEY,
  completed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS "adcp_reporting_webhook_attempts_ordinals" (
  namespace           TEXT NOT NULL,
  tenant_key          TEXT NOT NULL,
  principal_key       TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  subscriber_id       TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  next_attempt        INTEGER NOT NULL DEFAULT 2,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key),
  CHECK (tenant_key ~ '^[a-f0-9]{64}$'),
  CHECK (principal_key ~ '^[a-f0-9]{64}$'),
  CHECK (next_attempt > 1 AND next_attempt <= 1000001)
);
CREATE INDEX IF NOT EXISTS adcp_reporting_webhook_attempts_ord_ret
  ON "adcp_reporting_webhook_attempts_ordinals"(namespace, changed_at);

CREATE TABLE IF NOT EXISTS "adcp_reporting_webhook_attempts" (
  namespace           TEXT NOT NULL,
  tenant_key          TEXT NOT NULL,
  principal_key       TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  subscriber_id       TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  attempt             INTEGER NOT NULL,
  notification_id     TEXT NOT NULL,
  notification_type   TEXT NOT NULL,
  immutable_sha256    TEXT NOT NULL,
  fired_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'pending',
  url                 TEXT NOT NULL,
  http_status_code    INTEGER,
  response_time_ms    INTEGER,
  payload_size_bytes  INTEGER NOT NULL,
  error_message       TEXT,
  PRIMARY KEY (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key, attempt),
  CHECK (tenant_key ~ '^[a-f0-9]{64}$'),
  CHECK (principal_key ~ '^[a-f0-9]{64}$'),
  CHECK (immutable_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (attempt > 0),
  CHECK (payload_size_bytes >= 0),
  CHECK (status IN ('pending', 'success', 'failed', 'timeout', 'connection_error')),
  CHECK ((status = 'pending') = (completed_at IS NULL)),
  CHECK ((status IN ('success', 'failed')) = (http_status_code IS NOT NULL)),
  CHECK ((status IN ('success', 'failed')) = (response_time_ms IS NOT NULL)),
  CHECK ((status IN ('pending', 'success')) = (error_message IS NULL)),
  CHECK (notification_type IN ('reporting.delivery_ready', 'reporting.status_changed', 'reporting.ledger_changed'))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_webhook_attempts_newest
  ON "adcp_reporting_webhook_attempts"(namespace, tenant_key, principal_key, account_id, fired_at DESC, attempt DESC);
CREATE INDEX IF NOT EXISTS adcp_reporting_webhook_attempts_retention
  ON "adcp_reporting_webhook_attempts"(namespace, completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_webhook_attempts_pending_retention
  ON "adcp_reporting_webhook_attempts"(namespace, fired_at) WHERE completed_at IS NULL;
WITH first_backfill AS (
  INSERT INTO "adcp_reporting_webhook_attempts_metadata" (migration_key) VALUES ('attempt-ordinal-backfill-v1')
  ON CONFLICT DO NOTHING RETURNING migration_key
)
INSERT INTO "adcp_reporting_webhook_attempts_ordinals"
  (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key, next_attempt)
SELECT namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key,
       LEAST(MAX(attempt) + 1, 1000001)
  FROM "adcp_reporting_webhook_attempts", first_backfill
 GROUP BY namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key
ON CONFLICT (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key)
DO UPDATE SET next_attempt = GREATEST("adcp_reporting_webhook_attempts_ordinals".next_attempt, EXCLUDED.next_attempt),
              changed_at = clock_timestamp();

CREATE TABLE IF NOT EXISTS adcp_reporting_object_write_bindings (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  bucket TEXT NOT NULL,
  namespace_key TEXT NOT NULL CHECK (namespace_key ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (account_id, destination_ref, generation),
  FOREIGN KEY (account_id, destination_ref, generation)
    REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation)
);
CREATE TABLE IF NOT EXISTS adcp_reporting_object_write_plans (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  plan_id TEXT NOT NULL CHECK (plan_id ~ '^[a-f0-9]{64}$'),
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (account_id, destination_ref, generation, plan_id),
  FOREIGN KEY (account_id, destination_ref, generation)
    REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation)
);
CREATE TABLE IF NOT EXISTS adcp_reporting_object_writes (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  plan_id TEXT NOT NULL,
  object_index INTEGER NOT NULL CHECK (object_index >= 0 AND object_index < 128),
  bucket TEXT NOT NULL,
  object_name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 67108864),
  fenced_at TIMESTAMPTZ,
  tombstone_generation TEXT,
  PRIMARY KEY (account_id, destination_ref, generation, plan_id, object_index),
  UNIQUE (bucket, object_name),
  FOREIGN KEY (account_id, destination_ref, generation, plan_id)
    REFERENCES adcp_reporting_object_write_plans(account_id, destination_ref, generation, plan_id)
);


CREATE TABLE IF NOT EXISTS adcp_reporting_object_write_authority (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  installation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1)
);
INSERT INTO adcp_reporting_object_write_authority (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE host_source_executions (
 execution_key TEXT PRIMARY KEY,
 fingerprint TEXT NOT NULL,
 slice_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 object_ref TEXT NOT NULL UNIQUE,
 generation TEXT NOT NULL,
 account_id TEXT NOT NULL,
 source_scope JSONB NOT NULL,
 delivery_config_id TEXT NOT NULL,
 delivery_config_version INTEGER NOT NULL,
 reporting_obligation_id TEXT NOT NULL,
 report_definition_id TEXT NOT NULL,
 reference JSONB NOT NULL,
 manifest_bytes BYTEA NOT NULL,
 object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) <= 4194304)
);
CREATE TABLE host_installation (
 singleton BOOLEAN PRIMARY KEY CHECK (singleton),
 namespace TEXT NOT NULL,
 bucket TEXT NOT NULL
);
CREATE TABLE host_accounts (
 account_id TEXT PRIMARY KEY,
 principal_id TEXT NOT NULL UNIQUE,
 source_config_id TEXT NOT NULL,
 source_config_version INTEGER NOT NULL CHECK (source_config_version > 0),
 destination_ref TEXT NOT NULL,
 currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 media_buy_ids JSONB NOT NULL,
 installed_input JSONB NOT NULL
);
CREATE TABLE host_grants (
 account_id TEXT PRIMARY KEY REFERENCES host_accounts(account_id),
 destination_ref TEXT NOT NULL,
 generation BIGINT NOT NULL CHECK (generation > 0),
 reader_grant JSONB NOT NULL,
 FOREIGN KEY (account_id, destination_ref, generation) REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation)
);
