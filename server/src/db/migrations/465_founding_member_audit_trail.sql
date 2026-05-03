-- Add audit trail for founding member flag overrides on member_profiles.
-- Resolves issue #4014: is_founding_member was auto-set by migrations 147/180
-- with no record of who flipped it manually, when, or why.

ALTER TABLE member_profiles
  ADD COLUMN IF NOT EXISTS founding_member_source TEXT
    CHECK (founding_member_source IN ('auto_pre_cutoff', 'manual_grandfather')),
  ADD COLUMN IF NOT EXISTS founding_member_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS founding_member_granted_reason TEXT,
  ADD COLUMN IF NOT EXISTS founding_member_granted_by TEXT;

-- Backfill all auto-granted founding members (created before the cutoff date).
-- Guard on source IS NULL makes this idempotent if the migration re-runs.
UPDATE member_profiles
SET
  founding_member_source = 'auto_pre_cutoff',
  founding_member_granted_at = created_at
WHERE is_founding_member = TRUE
  AND created_at < '2026-04-01'::timestamptz
  AND founding_member_source IS NULL;

-- Backfill the one known manual grandfather (grandfathered 2026-05-03
-- after pre-deadline site issues blocked enrollment).
-- UUID and timestamp confirmed by repo owner in issue #4014.
UPDATE member_profiles
SET
  founding_member_source = 'manual_grandfather',
  founding_member_granted_at = '2026-05-03T18:22:35Z'::timestamptz,
  founding_member_granted_reason = 'site issues blocked pre-deadline enrollment'
WHERE id = 'b05f2b5a-aae8-4c72-b7d5-c7ffc8977988'
  AND is_founding_member = TRUE
  AND founding_member_source IS NULL;
