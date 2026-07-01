-- Identity layer (Phase 1).
--
-- An "identity" is the person; a WorkOS user is one credential bundle for one
-- email. Today every user is a singleton identity. Phase 2 will rewrite
-- mergeUsers to bind multiple WorkOS users to a single identity instead of
-- deleting the secondary user, so that "linked emails" actually work for
-- sign-in (each email is a real WorkOS user) and the local DB becomes a
-- truthful cache of WorkOS state.
--
-- This migration adds the tables, backfills 1:1 from `users`, and installs an
-- AFTER INSERT trigger so any new user automatically gets a singleton
-- identity. No app code reads identity_id yet — that comes in Phase 2.

CREATE TABLE identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- workos_user_id PK enforces "one WorkOS user belongs to exactly one identity".
-- Multiple rows with the same identity_id model "this person has multiple
-- sign-in emails" (each email is its own WorkOS user).
CREATE TABLE identity_workos_users (
  workos_user_id VARCHAR(255) PRIMARY KEY REFERENCES users(workos_user_id) ON DELETE CASCADE,
  identity_id UUID NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_identity_workos_users_identity ON identity_workos_users(identity_id);

-- Exactly one primary WorkOS user per identity.
CREATE UNIQUE INDEX idx_identity_workos_users_one_primary
  ON identity_workos_users(identity_id) WHERE is_primary = TRUE;

-- Backfill: one identity per existing user, marked primary. Use a transient
-- column to pair each new identity row with its source user in a single
-- set-based pass. Set-based is fine at current users-table size (low tens of
-- thousands); batch past ~100k.
ALTER TABLE identities ADD COLUMN _backfill_workos_user_id VARCHAR(255);

INSERT INTO identities (id, _backfill_workos_user_id)
SELECT gen_random_uuid(), workos_user_id FROM users;

INSERT INTO identity_workos_users (workos_user_id, identity_id, is_primary)
SELECT _backfill_workos_user_id, id, TRUE
FROM identities
WHERE _backfill_workos_user_id IS NOT NULL;

ALTER TABLE identities DROP COLUMN _backfill_workos_user_id;

-- Auto-create a singleton identity when a new user is inserted. Fires on
-- AFTER INSERT only — ON CONFLICT DO UPDATE upserts that update the existing
-- row fire AFTER UPDATE instead, which is correct (the existing user already
-- has an identity).
CREATE OR REPLACE FUNCTION ensure_identity_for_user() RETURNS TRIGGER AS $$
DECLARE
  new_identity_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_workos_users WHERE workos_user_id = NEW.workos_user_id
  ) THEN
    INSERT INTO identities DEFAULT VALUES RETURNING id INTO new_identity_id;
    INSERT INTO identity_workos_users (workos_user_id, identity_id, is_primary)
    VALUES (NEW.workos_user_id, new_identity_id, TRUE);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ensure_identity_for_user
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION ensure_identity_for_user();
