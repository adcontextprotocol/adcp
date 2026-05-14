-- Add a foreign key on users.primary_organization_id with ON DELETE SET NULL.
--
-- Why: the column is a denormalized pointer that 11+ read sites trust as the
-- caller's authorization scope (member tools, brand-feeds, registry-api,
-- resolve-caller-org, agent-publish gate, etc.). Until now the column was a
-- bare VARCHAR(255) — every other table that points at organizations declares
-- a FK with ON DELETE CASCADE or SET NULL (member_profiles, organization_domains,
-- organization_memberships, brands, referral_codes, slack_activity_tracking,
-- registry_audit_log, …) but `users` was the lone exception, so every code path
-- that drops an organizations row left this pointer dangling.
--
-- The dangling pointer surfaced as "Organization not found" 404s on tier-gated
-- routes (PR #4182 added the resolver self-heal; this migration removes the
-- structural source of the drift).
--
-- Three suspect write paths today:
--   - routes/organizations.ts (user self-deletes their workspace)
--   - routes/admin/accounts-billing.ts (admin force-deletes an account)
--   - db/org-merge-db.ts (merge two orgs — secondary gets DELETE'd, primary
--     pointers stay pointed at it). The companion code change in this PR
--     adds an explicit repoint to the merge transaction so SET NULL doesn't
--     fire there.
--
-- Strategy: declare the constraint NOT VALID first so existing rows that
-- already dangle don't block the migration; null those out with a single
-- UPDATE; then VALIDATE so the constraint becomes enforceable for future
-- inserts/updates as well.

-- Step 1: declare the FK with ON DELETE SET NULL, but skip validation of
-- existing rows. This is cheap (no table scan, no exclusive lock) and lets
-- us do the data fix in step 2 with the constraint already present so any
-- concurrent INSERT during the migration is also constrained.
ALTER TABLE users
  ADD CONSTRAINT users_primary_organization_id_fkey
  FOREIGN KEY (primary_organization_id)
  REFERENCES organizations(workos_organization_id)
  ON DELETE SET NULL
  NOT VALID;

-- Step 2: clear any pointer that doesn't resolve to a current organizations
-- row. The resolver (resolvePrimaryOrganization) re-derives from
-- organization_memberships on the next read, so this is exactly the same
-- end state PR #4182's self-heal would land on once each user authenticates.
UPDATE users
   SET primary_organization_id = NULL,
       updated_at = NOW()
 WHERE primary_organization_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM organizations o
     WHERE o.workos_organization_id = users.primary_organization_id
   );

-- Step 3: VALIDATE the constraint now that no row violates it. From here on,
-- any future delete of an organizations row automatically nulls the pointer
-- (no more dangling no_org_row drift), and any INSERT/UPDATE into users with
-- a bogus primary_organization_id is rejected at the DB level.
ALTER TABLE users
  VALIDATE CONSTRAINT users_primary_organization_id_fkey;
