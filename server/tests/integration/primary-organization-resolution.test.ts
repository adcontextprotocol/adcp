/**
 * Integration tests for resolvePrimaryOrganization + the
 * users-have-primary-organization invariant.
 *
 * Exercises the read-with-fallback path against real PostgreSQL so a refactor
 * that re-introduces the "NULL column = no org" trap doesn't pass CI.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resolvePrimaryOrganization } from '../../src/db/users-db.js';
import { usersHavePrimaryOrganizationInvariant } from '../../src/audit/integrity/invariants/users-have-primary-organization.js';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import type { WorkOS } from '@workos-inc/node';
import { createLogger } from '../../src/logger.js';

const TEST_USER = 'user_primary_org_test';
const TEST_USER_2 = 'user_primary_org_test_2';
const TEST_ORG_ACTIVE = 'org_primary_org_active';
const TEST_ORG_INACTIVE = 'org_primary_org_inactive';
const TEST_ORG_PERSONAL = 'org_primary_org_personal';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [
    [TEST_ORG_ACTIVE, TEST_ORG_INACTIVE, TEST_ORG_PERSONAL],
  ]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [
    [TEST_ORG_ACTIVE, TEST_ORG_INACTIVE, TEST_ORG_PERSONAL],
  ]);
  await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[TEST_USER, TEST_USER_2]]);
}

async function seedOrg(pool: Pool, orgId: string, opts: { subscription_status?: string | null; is_personal?: boolean } = {}) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, subscription_status, is_personal, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET subscription_status = EXCLUDED.subscription_status,
           is_personal = EXCLUDED.is_personal`,
    [orgId, `Test ${orgId}`, opts.subscription_status ?? null, opts.is_personal ?? false],
  );
}

async function seedUser(pool: Pool, userId: string, primaryOrgId: string | null = null) {
  await pool.query(
    `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (workos_user_id) DO UPDATE SET primary_organization_id = EXCLUDED.primary_organization_id`,
    [userId, `${userId}@test.com`, primaryOrgId],
  );
}

async function seedMembership(pool: Pool, userId: string, orgId: string) {
  await pool.query(
    `INSERT INTO organization_memberships (
       workos_user_id, workos_organization_id, workos_membership_id, email,
       role, seat_type, synced_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'member', 'community_only', NOW(), NOW(), NOW())
     ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
    [userId, orgId, `om_${userId}_${orgId}`, `${userId}@test.com`],
  );
}

describe('primary_organization_id resolution', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  describe('resolvePrimaryOrganization', () => {
    it('returns the cached column when both org and membership exist', async () => {
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_ACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      const result = await resolvePrimaryOrganization(TEST_USER);
      expect(result).toBe(TEST_ORG_ACTIVE);
    });

    it('falls back to organization_memberships when column is NULL and backfills', async () => {
      // Membership exists, primary_organization_id is NULL — Matt's situation.
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, null);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      const result = await resolvePrimaryOrganization(TEST_USER);
      expect(result).toBe(TEST_ORG_ACTIVE);

      // Backfill is fire-and-forget — poll until it lands rather than sleeping
      // a fixed interval, which flakes under load.
      const deadline = Date.now() + 2000;
      let backfilled: string | null = null;
      while (Date.now() < deadline) {
        const after = await pool.query<{ primary_organization_id: string | null }>(
          'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
          [TEST_USER],
        );
        backfilled = after.rows[0]?.primary_organization_id ?? null;
        if (backfilled) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(backfilled).toBe(TEST_ORG_ACTIVE);
    });

    it('prefers paying org when multiple memberships exist', async () => {
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedOrg(pool, TEST_ORG_INACTIVE, { subscription_status: null });
      await seedUser(pool, TEST_USER, null);
      await seedMembership(pool, TEST_USER, TEST_ORG_INACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      const result = await resolvePrimaryOrganization(TEST_USER);
      expect(result).toBe(TEST_ORG_ACTIVE);
    });

    it('returns null when the user has no memberships', async () => {
      await seedUser(pool, TEST_USER, null);

      const result = await resolvePrimaryOrganization(TEST_USER);
      expect(result).toBeNull();
    });

    it('returns null when the user does not exist at all', async () => {
      const result = await resolvePrimaryOrganization('user_does_not_exist_xyz');
      expect(result).toBeNull();
    });

    // Self-heal cases. The cached column was set but the join targets had
    // drifted; the bare-column read returned a phantom orgId that 404'd
    // every tier-gated route until repaired by hand. Migration 470 closes
    // the no_org_row class structurally via FK ON DELETE SET NULL — the
    // FK-driven cases below replace the previous "manually seed dangling
    // pointer" tests, which the FK now rejects at INSERT time.

    it('FK ON DELETE SET NULL fires when cached org is deleted; resolver re-derives', async () => {
      // User's cache points at INACTIVE; INACTIVE gets deleted; the FK
      // automatically nulls the pointer (CASCADE drops INACTIVE membership
      // too). Resolver should fall back to ACTIVE on the next read.
      await seedOrg(pool, TEST_ORG_INACTIVE, { subscription_status: null });
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_INACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_INACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_INACTIVE]);

      // FK should have nulled the pointer atomically with the DELETE.
      const after = await pool.query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [TEST_USER],
      );
      expect(after.rows[0]?.primary_organization_id).toBeNull();

      const result = await resolvePrimaryOrganization(TEST_USER);
      expect(result).toBe(TEST_ORG_ACTIVE);
    });

    it('falls through and repoints when cached pointer has no membership row (FK does not catch this)', async () => {
      // Org row still exists but the user has no membership for it — a
      // membership-delete path that bypassed deleteOrganizationMembership
      // (the FK protects no_org_row but not no_membership_row). The
      // resolver self-heal handles this class.
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedOrg(pool, TEST_ORG_INACTIVE, { subscription_status: null });
      await seedUser(pool, TEST_USER, TEST_ORG_INACTIVE); // cache points at INACTIVE
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE); // but only member of ACTIVE

      const result = await resolvePrimaryOrganization(TEST_USER);
      expect(result).toBe(TEST_ORG_ACTIVE);

      const deadline = Date.now() + 2000;
      let cached: string | null = null;
      while (Date.now() < deadline) {
        const after = await pool.query<{ primary_organization_id: string | null }>(
          'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
          [TEST_USER],
        );
        cached = after.rows[0]?.primary_organization_id ?? null;
        if (cached === TEST_ORG_ACTIVE) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(cached).toBe(TEST_ORG_ACTIVE);
    });

    it('returns null when FK ON DELETE SET NULL leaves no remaining org', async () => {
      // Single org, single membership; org gets deleted. FK nulls the
      // pointer (and CASCADE drops the membership). Resolver returns null.
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_ACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ACTIVE]);

      const after = await pool.query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [TEST_USER],
      );
      expect(after.rows[0]?.primary_organization_id).toBeNull();

      const result = await resolvePrimaryOrganization(TEST_USER);
      expect(result).toBeNull();
    });
  });

  describe('users.primary_organization_id FK constraint', () => {
    it('rejects INSERT into users with a non-existent primary_organization_id', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [TEST_USER, `${TEST_USER}@test.com`, 'org_does_not_exist_fkey_test'],
        ),
      ).rejects.toThrow(/foreign key|fkey|primary_organization_id/i);
    });

    it('rejects UPDATE setting primary_organization_id to a non-existent org', async () => {
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_ACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      await expect(
        pool.query(
          `UPDATE users SET primary_organization_id = $1 WHERE workos_user_id = $2`,
          ['org_does_not_exist_fkey_test', TEST_USER],
        ),
      ).rejects.toThrow(/foreign key|fkey|primary_organization_id/i);
    });
  });

  describe('users-have-primary-organization invariant', () => {
    function ctx(): { pool: Pool; stripe: Stripe; workos: WorkOS; logger: ReturnType<typeof createLogger> } {
      // Invariant only touches pool — stripe/workos are unused for this DB-only check.
      return {
        pool: getPool(),
        stripe: {} as Stripe,
        workos: {} as WorkOS,
        logger: createLogger('test'),
      };
    }

    it('reports zero violations when all users with memberships have primary set', async () => {
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_ACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      const result = await usersHavePrimaryOrganizationInvariant.check(ctx());
      const ours = result.violations.filter((v) => v.subject_id === TEST_USER);
      expect(ours).toHaveLength(0);
    });

    it('reports a missing-pointer violation when a user has memberships but no primary set', async () => {
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, null);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      const result = await usersHavePrimaryOrganizationInvariant.check(ctx());
      const ours = result.violations.find((v) => v.subject_id === TEST_USER);
      expect(ours).toBeDefined();
      expect(ours!.severity).toBe('warning');
      expect(ours!.subject_type).toBe('user');
      expect(ours!.details).toMatchObject({
        drift: 'missing_pointer',
        workos_user_id: TEST_USER,
        inferred_org_id: TEST_ORG_ACTIVE,
      });
    });

    it('reports a stale-pointer violation when primary points at a removed-membership org', async () => {
      // User's primary points at an org, but the membership row was deleted
      // (e.g. missed/late delete webhook). Helper would still resolve them
      // into the removed org via the cached column.
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_ACTIVE);
      // Note: NO seedMembership — pointer is set but no membership row.

      const result = await usersHavePrimaryOrganizationInvariant.check(ctx());
      const ours = result.violations.find((v) => v.subject_id === TEST_USER);
      expect(ours).toBeDefined();
      expect(ours!.details).toMatchObject({
        drift: 'stale_pointer',
        stale_org_id: TEST_ORG_ACTIVE,
      });
    });

    it('skips personal-workspace memberships (not a real org affiliation)', async () => {
      await seedOrg(pool, TEST_ORG_PERSONAL, { is_personal: true });
      await seedUser(pool, TEST_USER, null);
      await seedMembership(pool, TEST_USER, TEST_ORG_PERSONAL);

      const result = await usersHavePrimaryOrganizationInvariant.check(ctx());
      const ours = result.violations.find((v) => v.subject_id === TEST_USER);
      expect(ours).toBeUndefined();
    });
  });

  describe('deleteOrganizationMembership clears stale primary_organization_id', () => {
    it('clears the column when it pointed at the deleted org', async () => {
      const { deleteOrganizationMembership } = await import('../../src/db/membership-db.js');
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_ACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);

      await deleteOrganizationMembership(TEST_USER, TEST_ORG_ACTIVE);

      const after = await pool.query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [TEST_USER],
      );
      expect(after.rows[0].primary_organization_id).toBeNull();
    });

    it('leaves the column alone when it pointed at a different org', async () => {
      const { deleteOrganizationMembership } = await import('../../src/db/membership-db.js');
      await seedOrg(pool, TEST_ORG_ACTIVE, { subscription_status: 'active' });
      await seedOrg(pool, TEST_ORG_INACTIVE, { subscription_status: 'active' });
      await seedUser(pool, TEST_USER, TEST_ORG_ACTIVE); // primary = active
      await seedMembership(pool, TEST_USER, TEST_ORG_ACTIVE);
      await seedMembership(pool, TEST_USER, TEST_ORG_INACTIVE);

      // Delete the OTHER membership; primary pointer should be untouched.
      await deleteOrganizationMembership(TEST_USER, TEST_ORG_INACTIVE);

      const after = await pool.query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [TEST_USER],
      );
      expect(after.rows[0].primary_organization_id).toBe(TEST_ORG_ACTIVE);
    });
  });
});
