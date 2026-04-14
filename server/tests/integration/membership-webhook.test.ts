/**
 * Membership webhook integration tests
 *
 * Exercises the actual SQL queries in membership-db against a real PostgreSQL
 * instance. Catches type-inference bugs (like the varchar/text mismatch that
 * broke all organization_membership webhooks in production).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  upsertOrganizationMembership,
  deleteOrganizationMembership,
  consumeInvitationSeatType,
  findSuccessorForPromotion,
  setMembershipRole,
  autoLinkByVerifiedDomain,
} from '../../src/db/membership-db.js';
import type { WorkOS } from '@workos-inc/node';
import type { Pool } from 'pg';

const TEST_ORG_ID = 'org_webhook_membership_test';
const TEST_AUTOLINK_ORG_ID = 'org_autolink_test';
const TEST_USER_1 = 'user_wh_test_1';
const TEST_USER_2 = 'user_wh_test_2';

describe('Membership webhook DB operations', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM invitation_seat_types WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM invitation_seat_types WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);
  });

  // =========================================================================
  // UPSERT
  // =========================================================================

  describe('upsertOrganizationMembership', () => {
    it('inserts a membership and auto-promotes first member to owner', async () => {
      const result = await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'alice@test.com',
        first_name: 'Alice',
        last_name: 'Test',
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      expect(result.assigned_role).toBe('owner');

      const row = await pool.query(
        'SELECT role, email, seat_type FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].role).toBe('owner');
      expect(row.rows[0].email).toBe('alice@test.com');
      expect(row.rows[0].seat_type).toBe('community_only');
    });

    it('assigns member role when org already has an owner', async () => {
      // First member becomes owner
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'alice@test.com',
        first_name: 'Alice',
        last_name: 'Test',
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      // Second member stays member
      const result = await upsertOrganizationMembership({
        user_id: TEST_USER_2,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_2',
        email: 'bob@test.com',
        first_name: 'Bob',
        last_name: 'Test',
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      expect(result.assigned_role).toBe('member');
    });

    it('preserves explicit admin role without auto-promotion logic', async () => {
      const result = await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'admin@test.com',
        first_name: 'Admin',
        last_name: 'User',
        role: 'admin',
        seat_type: 'contributor',
        has_explicit_seat_type: true,
      });

      expect(result.assigned_role).toBe('admin');
    });

    it('updates email on conflict but preserves existing names', async () => {
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'old@test.com',
        first_name: 'Old',
        last_name: 'Name',
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1_v2',
        email: 'new@test.com',
        first_name: 'New',
        last_name: 'Name',
        role: 'member',
        seat_type: 'contributor',
        has_explicit_seat_type: false,
      });

      const row = await pool.query(
        'SELECT email, first_name, workos_membership_id, seat_type FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].email).toBe('new@test.com');
      // Existing non-empty name is preserved (user may have set it via profile)
      expect(row.rows[0].first_name).toBe('Old');
      expect(row.rows[0].workos_membership_id).toBe('om_test_1_v2');
      // seat_type should NOT change when has_explicit_seat_type is false
      expect(row.rows[0].seat_type).toBe('community_only');
    });

    it('fills in names on conflict when existing names are empty', async () => {
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'empty@test.com',
        first_name: null,
        last_name: null,
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1_v2',
        email: 'empty@test.com',
        first_name: 'Filled',
        last_name: 'In',
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      const row = await pool.query(
        'SELECT first_name, last_name FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      // Empty names should be filled in from the incoming values
      expect(row.rows[0].first_name).toBe('Filled');
      expect(row.rows[0].last_name).toBe('In');
    });

    it('updates seat_type on conflict when has_explicit_seat_type is true', async () => {
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'alice@test.com',
        first_name: 'Alice',
        last_name: 'Test',
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'alice@test.com',
        first_name: 'Alice',
        last_name: 'Test',
        role: 'member',
        seat_type: 'contributor',
        has_explicit_seat_type: true,
      });

      const row = await pool.query(
        'SELECT seat_type FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].seat_type).toBe('contributor');
    });
  });

  // =========================================================================
  // DELETE
  // =========================================================================

  describe('deleteOrganizationMembership', () => {
    it('deletes and returns the role', async () => {
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'alice@test.com',
        first_name: 'Alice',
        last_name: 'Test',
        role: 'admin',
        seat_type: 'contributor',
        has_explicit_seat_type: true,
      });

      const role = await deleteOrganizationMembership(TEST_USER_1, TEST_ORG_ID);
      expect(role).toBe('admin');

      const check = await pool.query(
        'SELECT 1 FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('returns null for non-existent membership', async () => {
      const role = await deleteOrganizationMembership('user_nonexistent', TEST_ORG_ID);
      expect(role).toBeNull();
    });
  });

  // =========================================================================
  // INVITATION SEAT TYPES
  // =========================================================================

  describe('consumeInvitationSeatType', () => {
    it('returns and deletes the pending seat type', async () => {
      await pool.query(
        `INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type)
         VALUES ($1, $2, $3, $4)`,
        ['inv_test_1', TEST_ORG_ID, 'invited@test.com', 'contributor'],
      );

      const result = await consumeInvitationSeatType(TEST_ORG_ID, 'invited@test.com');
      expect(result).toBe('contributor');

      // Should be consumed (deleted)
      const second = await consumeInvitationSeatType(TEST_ORG_ID, 'invited@test.com');
      expect(second).toBeNull();
    });

    it('matches case-insensitively', async () => {
      await pool.query(
        `INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type)
         VALUES ($1, $2, $3, $4)`,
        ['inv_test_2', TEST_ORG_ID, 'CamelCase@Test.com', 'contributor'],
      );

      const result = await consumeInvitationSeatType(TEST_ORG_ID, 'camelcase@test.com');
      expect(result).toBe('contributor');
    });

    it('returns null when no invitation exists', async () => {
      const result = await consumeInvitationSeatType(TEST_ORG_ID, 'nobody@test.com');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // SUCCESSOR PROMOTION
  // =========================================================================

  describe('findSuccessorForPromotion', () => {
    it('returns longest-tenured member when no owner/admin exists', async () => {
      // Insert two members (no owner/admin)
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'om_s1', 'first@test.com', 'member', 'community_only', NOW() - interval '2 days', NOW(), NOW())`,
        [TEST_USER_1, TEST_ORG_ID],
      );
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'om_s2', 'second@test.com', 'member', 'community_only', NOW() - interval '1 day', NOW(), NOW())`,
        [TEST_USER_2, TEST_ORG_ID],
      );

      const successor = await findSuccessorForPromotion(TEST_ORG_ID);
      expect(successor).not.toBeNull();
      expect(successor!.workos_user_id).toBe(TEST_USER_1); // longest-tenured
      expect(successor!.workos_membership_id).toBe('om_s1');
    });

    it('returns null when org still has an owner', async () => {
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'owner@test.com', 'owner', 'contributor', NOW(), NOW(), NOW())`,
        [TEST_USER_1, TEST_ORG_ID],
      );
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'member@test.com', 'member', 'community_only', NOW(), NOW(), NOW())`,
        [TEST_USER_2, TEST_ORG_ID],
      );

      const successor = await findSuccessorForPromotion(TEST_ORG_ID);
      expect(successor).toBeNull();
    });
  });

  describe('setMembershipRole', () => {
    it('updates role to owner', async () => {
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'member@test.com', 'member', 'community_only', NOW(), NOW(), NOW())`,
        [TEST_USER_1, TEST_ORG_ID],
      );

      await setMembershipRole(TEST_USER_1, TEST_ORG_ID, 'owner');

      const row = await pool.query(
        'SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].role).toBe('owner');
    });

    it('demotes owner to member', async () => {
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'owner@test.com', 'owner', 'contributor', NOW(), NOW(), NOW())`,
        [TEST_USER_1, TEST_ORG_ID],
      );

      await setMembershipRole(TEST_USER_1, TEST_ORG_ID, 'member');

      const row = await pool.query(
        'SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].role).toBe('member');
    });
  });

  // =========================================================================
  // AUTO-LINK BY VERIFIED DOMAIN
  // =========================================================================

  describe('autoLinkByVerifiedDomain', () => {
    const AUTOLINK_USER = 'user_autolink_1';

    beforeEach(async () => {
      await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_AUTOLINK_ORG_ID]);
      await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_AUTOLINK_ORG_ID]);
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_AUTOLINK_ORG_ID]);
    });

    afterAll(async () => {
      await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_AUTOLINK_ORG_ID]);
      await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_AUTOLINK_ORG_ID]);
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_AUTOLINK_ORG_ID]);
    });

    function makeWorkOSMock(opts?: { shouldFail?: boolean; errorCode?: string }) {
      return {
        userManagement: {
          createOrganizationMembership: opts?.shouldFail
            ? vi.fn().mockRejectedValue(Object.assign(new Error('fail'), { code: opts.errorCode }))
            : vi.fn().mockResolvedValue({ id: 'om_auto_1' }),
        },
      } as unknown as WorkOS;
    }

    async function seedOrgWithVerifiedDomain(domain: string, subscriptionStatus = 'active', canceled = false) {
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, subscription_status, subscription_canceled_at, created_at, updated_at)
         VALUES ($1, 'AutoLink Corp', $2, $3, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET subscription_status = $2, subscription_canceled_at = $3`,
        [TEST_AUTOLINK_ORG_ID, subscriptionStatus, canceled ? new Date() : null],
      );
      await pool.query(
        `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
         VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
         ON CONFLICT (domain) DO UPDATE SET verified = true`,
        [TEST_AUTOLINK_ORG_ID, domain],
      );
    }

    it('creates membership when email domain matches verified domain with active subscription', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');

      expect(result).not.toBeNull();
      expect(result!.organizationId).toBe(TEST_AUTOLINK_ORG_ID);
      expect(result!.organizationName).toBe('AutoLink Corp');
      expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith({
        userId: AUTOLINK_USER,
        organizationId: TEST_AUTOLINK_ORG_ID,
        roleSlug: 'owner', // no existing admin/owner
      });
    });

    it('assigns member role when org already has an admin', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      // Add an existing owner
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ('user_existing_owner', $1, 'boss@autolink.com', 'owner', 'contributor', NOW(), NOW(), NOW())`,
        [TEST_AUTOLINK_ORG_ID],
      );
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');

      expect(result).not.toBeNull();
      expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith(
        expect.objectContaining({ roleSlug: 'member' }),
      );
    });

    it('returns null when no matching verified domain exists', async () => {
      const workos = makeWorkOSMock();
      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@nomatch.com');
      expect(result).toBeNull();
      expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
    });

    it('returns null when domain exists but subscription is not active', async () => {
      await seedOrgWithVerifiedDomain('autolink.com', 'canceled');
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');
      expect(result).toBeNull();
    });

    it('returns null when subscription is active but canceled', async () => {
      await seedOrgWithVerifiedDomain('autolink.com', 'active', true);
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');
      expect(result).toBeNull();
    });

    it('returns null when domain exists but is not verified', async () => {
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
         VALUES ($1, 'Unverified Corp', 'active', NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO NOTHING`,
        [TEST_AUTOLINK_ORG_ID],
      );
      await pool.query(
        `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
         VALUES ($1, 'unverified.com', false, true, 'manual', NOW(), NOW())
         ON CONFLICT (domain) DO UPDATE SET verified = false`,
        [TEST_AUTOLINK_ORG_ID],
      );
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@unverified.com');
      expect(result).toBeNull();
    });

    it('handles membership_already_exists gracefully', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      const workos = makeWorkOSMock({ shouldFail: true, errorCode: 'organization_membership_already_exists' });

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');
      expect(result).not.toBeNull();
      expect(result!.organizationId).toBe(TEST_AUTOLINK_ORG_ID);
    });

    it('returns null on other WorkOS errors', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      const workos = makeWorkOSMock({ shouldFail: true, errorCode: 'internal_error' });

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');
      expect(result).toBeNull();
    });

    it('handles email with no domain gracefully', async () => {
      const workos = makeWorkOSMock();
      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'nodomain');
      expect(result).toBeNull();
    });
  });
});
