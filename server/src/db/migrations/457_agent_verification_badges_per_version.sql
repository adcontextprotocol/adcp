-- Per-major-version AAO Verified badges (#3524, stage 1).
--
-- Extends agent_verification_badges so an agent can hold parallel
-- (Spec)/(Live) badges per AdCP minor version (3.0, 3.1, 4.0…). The
-- previous PK (agent_url, role) becomes (agent_url, role, major_version).
--
-- Behavior change is gated to a follow-up PR (stage 2). This migration:
--   1. Adds major_version with a default of '3.0' so existing writes keep
--      working unchanged during the rollout.
--   2. Backfills existing rows from verified_protocol_version (parsing
--      'X.Y.Z' → 'X.Y') with '3.0' as the fallback for null/malformed.
--   3. Rebuilds the PK to include major_version.
--   4. Drops the default after backfill so future writes must be explicit
--      (catch any missed call site at insert time, not at runtime).
--   5. Adds a CHECK constraint to keep major_version shaped like 'X.Y'.

BEGIN;

-- 1. Add column with temporary default so existing rows get a value.
ALTER TABLE agent_verification_badges
  ADD COLUMN IF NOT EXISTS major_version TEXT NOT NULL DEFAULT '3.0';

-- 2. Backfill from verified_protocol_version where available.
--    'X.Y.Z' → 'X.Y'; null or non-matching stays at the default '3.0'.
UPDATE agent_verification_badges
SET major_version = substring(verified_protocol_version FROM '^(\d+\.\d+)')
WHERE verified_protocol_version IS NOT NULL
  AND verified_protocol_version ~ '^\d+\.\d+';

-- 3. Rebuild the primary key.
ALTER TABLE agent_verification_badges DROP CONSTRAINT agent_verification_badges_pkey;
ALTER TABLE agent_verification_badges ADD PRIMARY KEY (agent_url, role, major_version);

-- 4. Drop the default — future writes must specify the version explicitly.
ALTER TABLE agent_verification_badges ALTER COLUMN major_version DROP DEFAULT;

-- 5. Constrain the shape. Two-segment dotted decimal, no leading zeros.
ALTER TABLE agent_verification_badges
  ADD CONSTRAINT valid_major_version
  CHECK (major_version ~ '^[1-9][0-9]*\.[0-9]+$');

-- 6. Indexes that filter by version. The role+status index already covers
--    most query paths; this is for the per-version badge listing in the
--    panel and brand.json enrichment.
CREATE INDEX IF NOT EXISTS idx_verification_badges_role_version
  ON agent_verification_badges(role, major_version, status);

COMMIT;
