-- Add a foreign key on brands.workos_organization_id with ON DELETE SET NULL.
--
-- Why: this column is a denormalized owner pointer that several read sites
-- and child tables trust (network_consistency_reports has a hard FK on
-- organizations(workos_organization_id) and inserts org_id sourced from
-- brands; member-db, federated-index, brand-property workflows all gate on
-- the same pointer). Migration 200 declared the FK when the table was
-- hosted_brands. Migration 389 merged hosted_brands into the wider brands
-- (formerly discovered_brands) table and re-added workos_organization_id as
-- a bare VARCHAR(255) — without the FK. From that point onward every
-- DELETE FROM organizations left brand rows pointing at a row that no
-- longer existed, and the network-consistency-reporter worker hit a noisy
-- FK violation on every cycle for those orgs (May 2026: org_01KC7R3...).
--
-- The deliberate "relinquish" path (deleteHostedBrand in brand-db.ts) moves
-- workos_organization_id → prior_owner_org_id explicitly before clearing,
-- so we don't want ON DELETE CASCADE here — losing the brand row on org
-- delete would be wrong. ON DELETE SET NULL matches the original migration
-- 200 declaration and the existing hosted_brands_delete trigger semantics
-- (which already clear the column to NULL when the legacy view path is
-- used to "delete" a hosted brand).
--
-- Strategy: declare the constraint NOT VALID first so existing rows that
-- already dangle don't block the migration; null those out with a single
-- UPDATE; then VALIDATE so the constraint becomes enforceable for future
-- inserts/updates as well.

-- Step 1: declare the FK with ON DELETE SET NULL, but skip validation of
-- existing rows. Cheap (no table scan, no exclusive lock) and lets us do
-- the data fix in step 3 with the constraint already present so any
-- concurrent INSERT during the migration is also constrained.
ALTER TABLE brands
  ADD CONSTRAINT brands_workos_organization_id_fkey
  FOREIGN KEY (workos_organization_id)
  REFERENCES organizations(workos_organization_id)
  ON DELETE SET NULL
  NOT VALID;

-- Step 2: mirror the deliberate-relinquish orphan state on every path that
-- nulls workos_organization_id, including the FK SET NULL cascade from
-- step 1 and the dangle-cleanup UPDATE in step 3.
--
-- Why: deleteHostedBrand in brand-db.ts ("relinquish") sets
-- workos_organization_id=NULL together with manifest_orphaned=TRUE,
-- is_public=FALSE, domain_verified=FALSE, and stashes prior_owner_org_id —
-- the brand goes off the public registry until a new owner claims it.
-- The bare FK SET NULL cascade nulls only the pointer, which would leave
-- the brand row in a "visible, verified, owner-less" state no other code
-- path produces: still publicly listed in the registry as a verified
-- brand with no current owner. Containment-wise we're still safe (the
-- next claim requires a fresh WorkOS DNS challenge — see
-- applyVerifiedBrandClaim), but the UX surface is wrong.
--
-- A BEFORE UPDATE trigger gated on "pointer cleared" mirrors the
-- relinquish state on every path: the FK cascade, the legacy
-- hosted_brands view delete trigger, the step-3 dangle UPDATE in this
-- migration, and any direct UPDATE. The org-merge layer-3 reparent in
-- mergeOrganizations updates the pointer to a new owner (non-NULL), so
-- this trigger does not fire on that path.
CREATE OR REPLACE FUNCTION brands_orphan_on_owner_cleared() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workos_organization_id IS NULL AND OLD.workos_organization_id IS NOT NULL THEN
    NEW.prior_owner_org_id := OLD.workos_organization_id;
    NEW.manifest_orphaned := TRUE;
    NEW.is_public := FALSE;
    NEW.domain_verified := FALSE;
    NEW.verification_token := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brands_orphan_on_owner_cleared_trigger ON brands;
CREATE TRIGGER brands_orphan_on_owner_cleared_trigger
  BEFORE UPDATE OF workos_organization_id ON brands
  FOR EACH ROW
  EXECUTE FUNCTION brands_orphan_on_owner_cleared();

-- Step 3: clear any pointer that doesn't resolve to a current
-- organizations row. The trigger from step 2 fires on each row, applying
-- the orphan state alongside the NULL. These rows were already
-- operationally unowned — every read path that gates on org existence
-- either 404s or short-circuits them. Orphaning here matches what the FK
-- cascade + trigger would have produced had they been in place when each
-- parent was deleted.
UPDATE brands
   SET workos_organization_id = NULL,
       updated_at = NOW()
 WHERE workos_organization_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM organizations o
     WHERE o.workos_organization_id = brands.workos_organization_id
   );

-- Step 4: VALIDATE the constraint now that no row violates it. From here
-- on, any DELETE FROM organizations automatically nulls the brand pointer
-- (no more dangling no_parent_row drift), and any INSERT/UPDATE into
-- brands with a bogus workos_organization_id is rejected at the DB level.
ALTER TABLE brands
  VALIDATE CONSTRAINT brands_workos_organization_id_fkey;
