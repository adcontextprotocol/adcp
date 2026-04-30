-- Migration: invite event lifecycle support
--
-- Adds two pieces that the per-person invite event log (issue #3588) needs:
--
-- 1. A stable surrogate key on membership_invites. The token is a credential
--    (anyone holding it can accept the invite), so it is unsafe to use as the
--    public reference in person_events. invite_id gives us a non-secret UUID
--    that events and any future tooling can reference without leaking accept
--    capability.
--
-- 2. A partial unique index on person_events for the four invite event types,
--    keyed on data->>'invite_id'. This makes invite-event writes idempotent
--    (ON CONFLICT DO NOTHING) without a NOT EXISTS pre-check, which is
--    race-prone and unindexed.
--
-- Source-of-truth rule documented elsewhere: membership_invites holds the
-- current state of an invite; person_events holds its history. Read the row
-- to answer "is this expired now"; read the events to answer "what happened".

-- ADD COLUMN with DEFAULT gen_random_uuid() is volatile, so PG rewrites
-- the table under ACCESS EXCLUSIVE. This table is small in production
-- (low hundreds of rows at most — verified before shipping); the rewrite
-- and follow-on UNIQUE index build are quick. If the table grows
-- substantially before this migration ships, split into:
--   1. ADD COLUMN id UUID
--   2. UPDATE ... SET id = gen_random_uuid() in batches
--   3. ALTER COLUMN id SET NOT NULL, SET DEFAULT gen_random_uuid()
--   4. CREATE UNIQUE INDEX CONCURRENTLY ... ; ADD CONSTRAINT ... USING INDEX
ALTER TABLE membership_invites
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_invites_id_key'
  ) THEN
    ALTER TABLE membership_invites
      ADD CONSTRAINT membership_invites_id_key UNIQUE (id);
  END IF;
END $$;

COMMENT ON COLUMN membership_invites.id IS
  'Stable surrogate key. Use this (not token) when referring to an invite from outside the invites table — token is a credential.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_events_invite_dedupe
  ON person_events (event_type, (data->>'invite_id'))
  WHERE event_type IN ('invite_sent', 'invite_accepted', 'invite_revoked', 'invite_expired');

COMMENT ON INDEX idx_person_events_invite_dedupe IS
  'Idempotency guard for invite-lifecycle events. Insert with ON CONFLICT DO NOTHING.';
