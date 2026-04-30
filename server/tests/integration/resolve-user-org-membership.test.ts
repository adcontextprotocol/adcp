/**
 * Integration tests for resolveUserOrgMembership.
 *
 * Two paths to verify:
 *   1. Dev mode — synthesizes membership from local organization_memberships
 *      cache (seeded by dev-setup at boot). No WorkOS round-trip.
 *   2. Prod mode — defers to WorkOS. Tested via mock; real WorkOS isn't
 *      in scope of integration tests.
 *
 * The whole point of this helper is removing the per-route dev-mode bypass
 * that broke /api/organizations/* in dev. The dev-mode test confirms the
 * bypass actually works.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Force dev mode + dev users on. The helper's dev-mode bypass reads
// isDevModeEnabled() and DEV_USERS, both module-load constants — mock
// before the helper imports them.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return { ...actual, isDevModeEnabled: () => true };
});

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resolveUserOrgMembership } from '../../src/utils/resolve-user-org-membership.js';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';

// Match an entry in DEV_USERS so isDevModeEnabled + DEV_USERS lookup pass.
const DEV_ADMIN_USER = 'user_dev_admin_001';
const DEV_MEMBER_USER = 'user_dev_member_001';
const DEV_ORG = 'org_dev_company_001';
const NON_DEV_USER = 'user_real_workos_test';
const NON_DEV_ORG = 'org_real_workos_test';

describe('resolveUserOrgMembership', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  describe('dev mode bypass', () => {
    it('returns the role from local organization_memberships when caller is a dev user', async () => {
      await seedOrg(pool, DEV_ORG);
      await seedMembership(pool, DEV_ADMIN_USER, DEV_ORG, 'owner');

      // workos arg is a no-op in dev path — pass null to prove it.
      const result = await resolveUserOrgMembership(null, DEV_ADMIN_USER, DEV_ORG);

      expect(result).toEqual({ role: 'owner', status: 'active', via_dev_bypass: true });
    });

    it('returns null for a dev user who has no membership in the requested org', async () => {
      await seedOrg(pool, DEV_ORG);
      // Don't seed membership.

      const result = await resolveUserOrgMembership(null, DEV_ADMIN_USER, DEV_ORG);

      expect(result).toBeNull();
    });

    it('normalizes unknown role values to member', async () => {
      await seedOrg(pool, DEV_ORG);
      await seedMembership(pool, DEV_MEMBER_USER, DEV_ORG, 'weirdRole');

      const result = await resolveUserOrgMembership(null, DEV_MEMBER_USER, DEV_ORG);

      expect(result).toEqual({ role: 'member', status: 'active', via_dev_bypass: true });
    });

    it('falls through to WorkOS for users not in DEV_USERS even when dev mode is enabled', async () => {
      const mockWorkos = {
        userManagement: {
          listOrganizationMemberships: vi.fn().mockResolvedValue({
            data: [{ status: 'active', role: { slug: 'admin' } }],
          }),
        },
      } as unknown as WorkOS;

      // NON_DEV_USER isn't in DEV_USERS, so we hit WorkOS even in dev mode.
      const result = await resolveUserOrgMembership(mockWorkos, NON_DEV_USER, NON_DEV_ORG);

      expect(result).toEqual({ role: 'admin', status: 'active', via_dev_bypass: false });
      expect(mockWorkos.userManagement.listOrganizationMemberships).toHaveBeenCalledWith({
        userId: NON_DEV_USER,
        organizationId: NON_DEV_ORG,
      });
    });
  });

  describe('WorkOS path', () => {
    it('returns the highest-privilege active role from WorkOS memberships', async () => {
      const mockWorkos = {
        userManagement: {
          listOrganizationMemberships: vi.fn().mockResolvedValue({
            data: [
              { status: 'pending', role: { slug: 'owner' } },
              { status: 'active', role: { slug: 'admin' } },
              { status: 'active', role: { slug: 'member' } },
            ],
          }),
        },
      } as unknown as WorkOS;

      const result = await resolveUserOrgMembership(mockWorkos, NON_DEV_USER, NON_DEV_ORG);

      // 'admin' is the highest active role; pending 'owner' is filtered out.
      expect(result?.role).toBe('admin');
      expect(result?.status).toBe('active');
    });

    it('returns null when WorkOS reports zero memberships', async () => {
      const mockWorkos = {
        userManagement: {
          listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }),
        },
      } as unknown as WorkOS;

      const result = await resolveUserOrgMembership(mockWorkos, NON_DEV_USER, NON_DEV_ORG);

      expect(result).toBeNull();
    });

    it('returns null when only inactive memberships exist (no active role)', async () => {
      const mockWorkos = {
        userManagement: {
          listOrganizationMemberships: vi.fn().mockResolvedValue({
            data: [
              { status: 'pending', role: { slug: 'admin' } },
              { status: 'inactive', role: { slug: 'owner' } },
            ],
          }),
        },
      } as unknown as WorkOS;

      const result = await resolveUserOrgMembership(mockWorkos, NON_DEV_USER, NON_DEV_ORG);

      expect(result).toBeNull();
    });

    it('returns null when the WorkOS client is missing', async () => {
      // Use a non-DEV user so the dev-mode path doesn't bypass.
      const result = await resolveUserOrgMembership(null, NON_DEV_USER, NON_DEV_ORG);

      expect(result).toBeNull();
    });
  });
});

async function cleanup(pool: Pool) {
  await pool.query(
    'DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)',
    [[DEV_ORG, NON_DEV_ORG]],
  );
  await pool.query(
    'DELETE FROM organizations WHERE workos_organization_id = ANY($1)',
    [[DEV_ORG, NON_DEV_ORG]],
  );
}

async function seedOrg(pool: Pool, orgId: string) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
     VALUES ($1, $1, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [orgId],
  );
}

async function seedMembership(pool: Pool, userId: string, orgId: string, role: string) {
  await pool.query(
    `INSERT INTO organization_memberships (
       workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, synced_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'community_only', NOW(), NOW(), NOW())
     ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, orgId, `mem_${userId}_${orgId}`, `${userId}@test.com`, role],
  );
}
