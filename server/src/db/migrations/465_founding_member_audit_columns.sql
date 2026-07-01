-- Audit trail for member_profiles.is_founding_member.
-- The flag was being set both automatically (created_at < cutoff) and
-- manually (admin override) with no way to distinguish the two.

ALTER TABLE member_profiles
  ADD COLUMN IF NOT EXISTS founding_member_source TEXT
    CHECK (founding_member_source IN ('auto_pre_cutoff', 'manual_grandfather')),
  ADD COLUMN IF NOT EXISTS founding_member_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS founding_member_granted_reason TEXT;

-- Backfill auto-grants: every existing founding member whose profile
-- predates the 2026-04-01 cutoff was set by migration 147/180.
UPDATE member_profiles
SET founding_member_source = 'auto_pre_cutoff',
    founding_member_granted_at = created_at
WHERE is_founding_member = TRUE
  AND created_at < '2026-04-01'::timestamptz
  AND founding_member_source IS NULL;

-- Backfill the one known manual grandfather (Affinity Answers, flipped
-- 2026-05-03 after Vivek reported pre-deadline site issues). Idempotent
-- via the workos_organization_id match plus the IS NULL guard.
UPDATE member_profiles
SET founding_member_source = 'manual_grandfather',
    founding_member_granted_at = '2026-05-03T18:22:35Z'::timestamptz,
    founding_member_granted_reason = 'Pre-deadline enrollment blocked by site issues; grandfathered per Vivek/Affinity Answers'
WHERE workos_organization_id = 'org_01KKBDJPRJ7WDX4W4MASFN33Y0'
  AND is_founding_member = TRUE
  AND founding_member_source IS NULL;

-- Defensive: any remaining flagged row with no source is a manual grant
-- whose context has been lost. Mark it as manual with a self-documenting
-- reason so the audit row isn't indistinguishable from a real grant later.
UPDATE member_profiles
SET founding_member_source = 'manual_grandfather',
    founding_member_granted_at = COALESCE(founding_member_granted_at, updated_at),
    founding_member_granted_reason = COALESCE(
      founding_member_granted_reason,
      'backfill: pre-migration manual grant; original context not recorded'
    )
WHERE is_founding_member = TRUE
  AND founding_member_source IS NULL;
