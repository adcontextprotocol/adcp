-- Allocation re-audited 2026-09-13T14:47:22.073294+00:00 against main dd6b04964a000f82ebd687e817e8e748fe73eb5c.
-- All 33 open PRs / 2891 files were fully paginated; heads were rechecked.
-- 592 remains owned only by #7463 and has not been released on main.
-- 588-591 belong to other slices; 591 exclusively PR1c (#7457).
-- No dependency on those migrations. Exact ledger heads/checksums are in the PR body.
-- Retain journal evidence without a users FK, including after account deletion.
ALTER TABLE users ADD COLUMN email_mutation_version BIGINT NOT NULL DEFAULT 0
  CHECK (email_mutation_version >= 0);

CREATE TABLE email_mutations (
  id UUID PRIMARY KEY,
  workos_user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  old_email TEXT NOT NULL,
  old_email_verified BOOLEAN NOT NULL,
  new_email TEXT NOT NULL,
  expected_email_version BIGINT NOT NULL CHECK (expected_email_version >= 0),
  applied_email_version BIGINT,
  epoch_after BIGINT CHECK (epoch_after > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'compensated', 'reconciliation_required')),
  failure_code TEXT CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  result_status INTEGER NOT NULL,
  result_body JSONB NOT NULL CHECK (
    jsonb_typeof(result_body) = 'object'
    AND result_body @> jsonb_build_object('operation_id', id::text)
  ),
  reconciliation_attempts JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(reconciliation_attempts) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workos_user_id, id),
  UNIQUE (workos_user_id, applied_email_version),
  CHECK (
    (state = 'pending' AND failure_code IS NULL)
    OR (state IN ('compensated', 'reconciliation_required') AND failure_code IS NOT NULL)
    OR (state = 'succeeded' AND failure_code IS NULL)
  ),
  CHECK (
    (state = 'pending'
      AND result_status = 409
      AND result_body @> '{"reconciliation_required":true}'::jsonb
      AND applied_email_version IS NULL AND epoch_after IS NULL)
    OR
    (state = 'reconciliation_required'
      AND result_status = 409
      AND result_body @> '{"reconciliation_required":true}'::jsonb
      AND applied_email_version IS NULL AND epoch_after IS NOT NULL)
    OR
    (state = 'succeeded' AND result_status = 200
      AND result_body @> jsonb_build_object('primary_email', new_email)
      AND result_body->>'reconciliation_required' IS DISTINCT FROM 'true'
      AND applied_email_version IS NOT NULL
      AND applied_email_version = expected_email_version + 1 AND epoch_after IS NOT NULL)
    OR
    (state = 'compensated' AND result_status BETWEEN 400 AND 599
      AND result_body ? 'error' AND jsonb_typeof(result_body->'error') = 'string'
      AND result_body->>'reconciliation_required' IS DISTINCT FROM 'true'
      AND applied_email_version IS NOT NULL
      AND applied_email_version = expected_email_version + 1 AND epoch_after IS NOT NULL)
  )
);

CREATE UNIQUE INDEX email_mutations_one_unresolved_credential
  ON email_mutations (workos_user_id)
  WHERE state IN ('pending', 'reconciliation_required');
CREATE INDEX email_mutations_credential_history
  ON email_mutations (workos_user_id, expected_email_version DESC);

-- Every writer uses the saga's credential lock. A BEFORE row trigger already
-- holds tuple locks: waiting here would invert the saga's advisory -> row order.
CREATE FUNCTION lock_email_writer(credential_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF credential_id IS NOT NULL
     AND NOT pg_try_advisory_xact_lock(hashtextextended(credential_id, 6827)) THEN
    RAISE EXCEPTION 'Credential email mutation is busy' USING ERRCODE = '55P03';
  END IF;
END;
$$;

CREATE FUNCTION protect_email_mutation_intent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_email_writer(NEW.workos_user_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NOT EXISTS (
      SELECT 1 FROM users WHERE workos_user_id = NEW.workos_user_id
        AND email = NEW.old_email AND email_verified = NEW.old_email_verified
        AND email_mutation_version = NEW.expected_email_version
    ) THEN
      RAISE EXCEPTION 'Email mutation must start pending from the current credential version' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.workos_user_id, NEW.actor_user_id, NEW.payload_hash,
           NEW.old_email, NEW.old_email_verified, NEW.new_email, NEW.expected_email_version)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.workos_user_id, OLD.actor_user_id, OLD.payload_hash,
           OLD.old_email, OLD.old_email_verified, OLD.new_email, OLD.expected_email_version) THEN
      RAISE EXCEPTION 'Email mutation intent is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state IN ('succeeded', 'compensated') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Email mutation terminal result is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IN ('succeeded', 'compensated')
       AND NEW.id::text IS DISTINCT FROM NULLIF(current_setting('adcp.email_mutation_id', true), '') THEN
      RAISE EXCEPTION 'Email mutation terminal result requires its operation transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_email_mutation_intent
  BEFORE INSERT OR UPDATE ON email_mutations
  FOR EACH ROW EXECUTE FUNCTION protect_email_mutation_intent();

CREATE FUNCTION fence_credential_email_writer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  canonical users%ROWTYPE;
  operation email_mutations%ROWTYPE;
  operation_setting TEXT := NULLIF(current_setting('adcp.email_mutation_id', true), '');
  protected BOOLEAN;
  previous_epoch BIGINT;
  updated_epoch BIGINT;
  affected_rows BIGINT;
BEGIN
  PERFORM lock_email_writer(NEW.workos_user_id);
  IF TG_OP = 'UPDATE' THEN
    canonical := OLD;
    IF NEW.workos_user_id IS DISTINCT FROM OLD.workos_user_id THEN
      PERFORM lock_email_writer(OLD.workos_user_id);
      IF EXISTS (SELECT 1 FROM email_mutations WHERE workos_user_id IN (OLD.workos_user_id, NEW.workos_user_id)) THEN
        RAISE EXCEPTION 'Journaled credential identity cannot be reassigned' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    -- Also fence INSERT ... ON CONFLICT before it can apply a stale EXCLUDED
    -- snapshot. This covers OAuth callbacks, webhooks, MCP and periodic resync.
    SELECT * INTO canonical FROM users WHERE workos_user_id = NEW.workos_user_id;
  END IF;
  SELECT EXISTS (SELECT 1 FROM email_mutations WHERE workos_user_id = NEW.workos_user_id) INTO protected;
  IF operation_setting IS NOT NULL AND TG_OP = 'UPDATE' THEN
    SELECT * INTO operation FROM email_mutations
      WHERE id::text = operation_setting AND workos_user_id = NEW.workos_user_id
        AND state IN ('pending', 'reconciliation_required');
    IF operation.id IS NULL
       OR canonical.email_mutation_version <> operation.expected_email_version
       OR NEW.email_mutation_version <> canonical.email_mutation_version
       OR NOT COALESCE(((NEW.email = operation.new_email AND NEW.email_verified IS TRUE)
         OR (NEW.email = operation.old_email AND NEW.email_verified = operation.old_email_verified)), FALSE) THEN
      RAISE EXCEPTION 'Email mutation operation or version does not authorize this write' USING ERRCODE = '23514';
    END IF;
    -- Advance even when compensation rewrites the same pair after a rollback.
    NEW.email_mutation_version := canonical.email_mutation_version + 1;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.email_mutation_version <> canonical.email_mutation_version THEN
    RAISE EXCEPTION 'Credential email version is managed by the writer fence' USING ERRCODE = '23514';
  END IF;
  IF protected AND (canonical.workos_user_id IS NULL
      OR NEW.email IS DISTINCT FROM canonical.email
      OR NEW.email_verified IS DISTINCT FROM canonical.email_verified) THEN
    -- A provider's updated_at cannot order a delayed mutation/compensation.
    -- The committed canonical pair stays authoritative until a new journaled
    -- operation is resolved. This remains active after terminal outcomes.
    RAISE EXCEPTION 'Credential email requires mutation reconciliation' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.email IS DISTINCT FROM OLD.email OR NEW.email_verified IS DISTINCT FROM OLD.email_verified) THEN
    NEW.email_mutation_version := OLD.email_mutation_version + 1;
    SELECT epoch INTO previous_epoch FROM authorization_epochs
      WHERE workos_user_id = NEW.workos_user_id FOR UPDATE;
    INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES (NEW.workos_user_id, 1)
      ON CONFLICT (workos_user_id) DO UPDATE
        SET epoch = authorization_epochs.epoch + 1, updated_at = NOW()
      RETURNING epoch INTO updated_epoch;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 OR updated_epoch IS DISTINCT FROM COALESCE(previous_epoch, 0) + 1
       OR NOT EXISTS (SELECT 1 FROM authorization_epochs
         WHERE workos_user_id = NEW.workos_user_id AND epoch = updated_epoch) THEN
      RAISE EXCEPTION 'Credential email write lacks its authorization epoch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_credential_email_writer
  BEFORE INSERT OR UPDATE OF email, email_verified, email_mutation_version, workos_user_id ON users
  FOR EACH ROW EXECUTE FUNCTION fence_credential_email_writer();

-- An authorized UPDATE cannot commit while its journal is still pending, or
-- after a trigger silently skipped the journal/epoch write. Match the persisted
-- monotonic version, never caller UUID order or potentially tied timestamps.
CREATE FUNCTION verify_email_mutation_commit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  operation email_mutations%ROWTYPE;
BEGIN
  IF NEW.email_mutation_version = OLD.email_mutation_version THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM email_mutations WHERE workos_user_id = NEW.workos_user_id) THEN RETURN NULL; END IF;
  SELECT * INTO operation FROM email_mutations
    WHERE workos_user_id = NEW.workos_user_id AND applied_email_version = NEW.email_mutation_version
      AND state IN ('succeeded', 'compensated');
  IF operation.id IS NULL
     OR (operation.state = 'succeeded' AND (NEW.email <> operation.new_email OR NEW.email_verified IS DISTINCT FROM TRUE))
     OR (operation.state = 'compensated' AND (NEW.email <> operation.old_email OR NEW.email_verified IS DISTINCT FROM operation.old_email_verified))
     OR NOT EXISTS (SELECT 1 FROM authorization_epochs
       WHERE workos_user_id = NEW.workos_user_id AND epoch = operation.epoch_after) THEN
    RAISE EXCEPTION 'Email mutation local commit lacks its terminal journal and epoch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER verify_email_mutation_commit
  AFTER UPDATE ON users DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_email_mutation_commit();

CREATE FUNCTION verify_email_mutation_terminal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'reconciliation_required' AND NOT EXISTS (
    SELECT 1 FROM users u JOIN authorization_epochs epoch USING (workos_user_id)
      WHERE u.workos_user_id = NEW.workos_user_id
        AND u.email_mutation_version = NEW.expected_email_version
        AND u.email = NEW.old_email AND u.email_verified = NEW.old_email_verified
        AND epoch.epoch >= NEW.epoch_after
  ) THEN
    RAISE EXCEPTION 'Email reconciliation lacks matching local evidence and revocation' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('succeeded', 'compensated') AND NOT EXISTS (
    SELECT 1 FROM users u JOIN authorization_epochs epoch USING (workos_user_id)
      WHERE u.workos_user_id = NEW.workos_user_id
        AND u.email_mutation_version = NEW.applied_email_version
        AND epoch.epoch = NEW.epoch_after
        AND ((NEW.state = 'succeeded' AND u.email = NEW.new_email AND u.email_verified IS TRUE)
          OR (NEW.state = 'compensated' AND u.email = NEW.old_email AND u.email_verified = NEW.old_email_verified))
  ) THEN
    RAISE EXCEPTION 'Email mutation terminal result lacks matching local evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER verify_email_mutation_terminal
  AFTER INSERT OR UPDATE ON email_mutations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_email_mutation_terminal();

CREATE FUNCTION fence_email_denormalization_writer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  canonical_email TEXT;
BEGIN
  PERFORM lock_email_writer(NEW.workos_user_id);
  IF TG_OP = 'UPDATE' AND OLD.workos_user_id IS DISTINCT FROM NEW.workos_user_id THEN
    PERFORM lock_email_writer(OLD.workos_user_id);
  END IF;
  IF EXISTS (SELECT 1 FROM email_mutations WHERE workos_user_id = NEW.workos_user_id) THEN
    SELECT email INTO canonical_email FROM users WHERE workos_user_id = NEW.workos_user_id;
    IF canonical_email IS NULL THEN
      RAISE EXCEPTION 'Credential email denormalization requires reconciliation' USING ERRCODE = '23514';
    END IF;
    -- Keep role/status revocations from mixed provider snapshots effective;
    -- only their stale denormalized email is replaced by the canonical value.
    NEW.email := canonical_email;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_membership_email_writer
  BEFORE INSERT OR UPDATE OF email, workos_user_id ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION fence_email_denormalization_writer();
CREATE TRIGGER fence_person_email_writer
  BEFORE INSERT OR UPDATE OF email, workos_user_id ON person_relationships
  FOR EACH ROW EXECUTE FUNCTION fence_email_denormalization_writer();

CREATE FUNCTION fence_email_alias_token_writer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  old_owner TEXT;
  new_owner TEXT;
  owner_id TEXT;
  operation email_mutations%ROWTYPE;
  operation_setting TEXT := NULLIF(current_setting('adcp.email_mutation_id', true), '');
BEGIN
  IF TG_TABLE_NAME = 'user_email_aliases' THEN
    IF TG_OP <> 'INSERT' THEN old_owner := OLD.workos_user_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_owner := NEW.workos_user_id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN old_owner := OLD.primary_workos_user_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_owner := NEW.primary_workos_user_id; END IF;
  END IF;
  FOR owner_id IN SELECT DISTINCT owner FROM unnest(ARRAY[old_owner, new_owner]) owner WHERE owner IS NOT NULL ORDER BY owner LOOP
    PERFORM lock_email_writer(owner_id);
    -- A provider-authoritative users DELETE must finish its FK cascades so
    -- memberships and sessions can be revoked. The deleted parent is absent
    -- inside that transaction; a direct alias/token DELETE still sees it and
    -- remains fenced. The journal has no users FK and retains the evidence.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM users WHERE workos_user_id = owner_id) THEN
      CONTINUE;
    END IF;
    SELECT * INTO operation FROM email_mutations WHERE workos_user_id = owner_id
      AND state IN ('pending', 'reconciliation_required');
    IF operation.id IS NOT NULL THEN
      IF TG_TABLE_NAME <> 'user_email_aliases'
         OR operation.id::text IS DISTINCT FROM operation_setting
         OR (old_owner IS NOT NULL AND old_owner <> owner_id)
         OR (new_owner IS NOT NULL AND new_owner <> owner_id)
         OR (TG_OP <> 'INSERT' AND to_jsonb(OLD)->>'email' NOT IN (operation.old_email, operation.new_email))
         OR (TG_OP <> 'DELETE' AND to_jsonb(NEW)->>'email' NOT IN (operation.old_email, operation.new_email)) THEN
        RAISE EXCEPTION 'Credential alias or token mutation requires reconciliation' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_email_alias_writer
  BEFORE INSERT OR UPDATE OR DELETE ON user_email_aliases
  FOR EACH ROW EXECUTE FUNCTION fence_email_alias_token_writer();
CREATE TRIGGER fence_email_link_token_writer
  BEFORE INSERT OR UPDATE OR DELETE ON email_link_tokens
  FOR EACH ROW EXECUTE FUNCTION fence_email_alias_token_writer();
