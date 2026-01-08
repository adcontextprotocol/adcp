-- Migration: Migrate legacy prospect_owner text field to org_stakeholders table
--
-- Background:
-- The organizations.prospect_owner field stores names like "Brian", "Randy", "Matt"
-- as plain text. The org_stakeholders table supports proper ownership tracking with
-- user IDs, roles, and multiple stakeholders per organization.
--
-- This migration creates stakeholder records for existing prospect_owner values.
-- This is a one-time migration for known legacy data.

-- Map legacy prospect_owner names to actual admin user emails
-- Brian -> brian@agenticadvertising.org
-- Randy/Randall -> randall@randallrothenberg.com
-- Matt -> matt@journeysparkconsulting.com

BEGIN;

INSERT INTO org_stakeholders (organization_id, user_id, user_name, user_email, role, notes)
SELECT
  o.workos_organization_id,
  u.workos_user_id,
  CASE
    WHEN LOWER(o.prospect_owner) LIKE 'brian%' THEN 'Brian'
    WHEN LOWER(o.prospect_owner) LIKE 'rand%' THEN 'Randy'
    WHEN LOWER(o.prospect_owner) LIKE 'matt%' THEN 'Matt'
  END as user_name,
  u.email,
  'owner',
  'Migrated from legacy prospect_owner field on ' || CURRENT_DATE
FROM organizations o
JOIN users u ON (
  (LOWER(o.prospect_owner) LIKE 'brian%' AND LOWER(u.email) = 'brian@agenticadvertising.org') OR
  (LOWER(o.prospect_owner) LIKE 'rand%' AND LOWER(u.email) = 'randall@randallrothenberg.com') OR
  (LOWER(o.prospect_owner) LIKE 'matt%' AND LOWER(u.email) = 'matt@journeysparkconsulting.com')
)
WHERE o.prospect_owner IS NOT NULL
  AND o.prospect_owner != ''
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- Log how many were migrated
DO $$
DECLARE
  migrated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO migrated_count
  FROM org_stakeholders
  WHERE notes LIKE 'Migrated from legacy prospect_owner%';

  RAISE NOTICE 'Migrated % prospect owners to org_stakeholders', migrated_count;
END $$;

-- Add comment explaining the migration
COMMENT ON COLUMN organizations.prospect_owner IS 'DEPRECATED: Use org_stakeholders table with role=owner. This field is kept for backward compatibility and will show in UI as fallback.';

COMMIT;
