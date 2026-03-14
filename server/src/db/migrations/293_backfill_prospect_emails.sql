-- Backfill prospect_contact_email from email_contacts
-- Some Addie-owned prospects have email_contacts records but no prospect_contact_email
-- on the organization. This fills in the gap and creates person_relationships rows
-- that migration 291 skipped because prospect_contact_email was NULL.

-- ─── Step 1: Fill in missing prospect_contact_email from email_contacts ───────

UPDATE organizations o
SET prospect_contact_email = ec.email,
    prospect_contact_name = COALESCE(o.prospect_contact_name, ec.display_name),
    updated_at = NOW()
FROM (
  SELECT DISTINCT ON (organization_id)
    organization_id, email, display_name
  FROM email_contacts
  WHERE organization_id IS NOT NULL
  ORDER BY organization_id, created_at DESC
) ec
WHERE o.workos_organization_id = ec.organization_id
  AND o.prospect_owner = 'addie'
  AND o.prospect_contact_email IS NULL;

-- ─── Step 2: Create person_relationships for newly-emailable prospects ────────

INSERT INTO person_relationships (
  email,
  prospect_org_id,
  display_name,
  stage,
  stage_changed_at,
  created_at
)
SELECT DISTINCT ON (o.prospect_contact_email)
  o.prospect_contact_email,
  o.workos_organization_id,
  COALESCE(o.prospect_contact_name, o.name),
  'prospect',
  NOW(),
  NOW()
FROM organizations o
WHERE o.prospect_owner = 'addie'
  AND o.prospect_contact_email IS NOT NULL
  AND o.subscription_status IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM person_relationships pr
    WHERE pr.email = o.prospect_contact_email
  )
  AND NOT EXISTS (
    SELECT 1 FROM person_relationships pr
    WHERE pr.prospect_org_id = o.workos_organization_id
  )
ORDER BY o.prospect_contact_email, o.created_at
ON CONFLICT DO NOTHING;
