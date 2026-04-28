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
  findOrgsWithNewAutoProvisionedMembers,
  listNewAutoProvisionedMembers,
  markAutoProvisionDigestSent,
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
    it('returns and deletes the pending seat type and source', async () => {
      await pool.query(
        `INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type, source)
         VALUES ($1, $2, $3, $4, $5)`,
        ['inv_test_1', TEST_ORG_ID, 'invited@test.com', 'contributor', 'invited'],
      );

      const result = await consumeInvitationSeatType(TEST_ORG_ID, 'invited@test.com');
      expect(result).toEqual({ seat_type: 'contributor', source: 'invited' });

      // Should be consumed (deleted)
      const second = await consumeInvitationSeatType(TEST_ORG_ID, 'invited@test.com');
      expect(second).toBeNull();
    });

    it('matches case-insensitively', async () => {
      await pool.query(
        `INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type, source)
         VALUES ($1, $2, $3, $4, $5)`,
        ['inv_test_2', TEST_ORG_ID, 'CamelCase@Test.com', 'contributor', 'invited'],
      );

      const result = await consumeInvitationSeatType(TEST_ORG_ID, 'camelcase@test.com');
      expect(result?.seat_type).toBe('contributor');
      expect(result?.source).toBe('invited');
    });

    it('returns null source when staging row predates the source column', async () => {
      // Backward compatibility: rows written before migration 436 have NULL source.
      await pool.query(
        `INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type)
         VALUES ($1, $2, $3, $4)`,
        ['inv_test_legacy', TEST_ORG_ID, 'legacy@test.com', 'community_only'],
      );

      const result = await consumeInvitationSeatType(TEST_ORG_ID, 'legacy@test.com');
      expect(result).toEqual({ seat_type: 'community_only', source: null });
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

    it('always creates membership as member; upsert path handles auto-promotion atomically', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');

      expect(result).not.toBeNull();
      expect(result!.organizationId).toBe(TEST_AUTOLINK_ORG_ID);
      expect(result!.organizationName).toBe('AutoLink Corp');
      expect(result!.role).toBe('member');
      expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith({
        userId: AUTOLINK_USER,
        organizationId: TEST_AUTOLINK_ORG_ID,
        roleSlug: 'member',
      });
    });

    it('still creates as member when org already has an admin', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
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

    it('returns null when org has auto_provision_verified_domain disabled', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      await pool.query(
        `UPDATE organizations SET auto_provision_verified_domain = false
         WHERE workos_organization_id = $1`,
        [TEST_AUTOLINK_ORG_ID],
      );
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');

      expect(result).toBeNull();
      expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
    });

    it('short-circuits when user already has a cached membership in the candidate org', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'matt@autolink.com', 'member', 'community_only', NOW(), NOW(), NOW())`,
        [AUTOLINK_USER, TEST_AUTOLINK_ORG_ID],
      );
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');

      expect(result).toBeNull();
      expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
    });

    it('still creates membership when user has memberships in OTHER orgs (the Triton case)', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      // Seed an unrelated personal org membership for the user.
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, 'org_personal_autolink_user', 'matt@autolink.com', 'owner', 'community_only', NOW(), NOW(), NOW())
         ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
        [AUTOLINK_USER],
      );
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');

      expect(result).not.toBeNull();
      expect(result!.organizationId).toBe(TEST_AUTOLINK_ORG_ID);
      expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: AUTOLINK_USER,
          organizationId: TEST_AUTOLINK_ORG_ID,
        }),
      );

      // Cleanup the personal-org seed
      await pool.query(
        `DELETE FROM organization_memberships WHERE workos_organization_id = 'org_personal_autolink_user'`,
      );
    });

    it('stages provisioning_source=verified_domain so the webhook can record it', async () => {
      await seedOrgWithVerifiedDomain('autolink.com');
      const workos = makeWorkOSMock();

      const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, 'matt@autolink.com');
      expect(result).not.toBeNull();

      // The staging row should now exist for the org+email pair so the
      // organization_membership.created webhook can consume it.
      const staged = await pool.query<{ seat_type: string; source: string | null }>(
        `SELECT seat_type, source FROM invitation_seat_types
         WHERE workos_organization_id = $1 AND lower(email) = lower($2)`,
        [TEST_AUTOLINK_ORG_ID, 'matt@autolink.com'],
      );
      expect(staged.rows[0]).toBeDefined();
      expect(staged.rows[0].seat_type).toBe('community_only');
      expect(staged.rows[0].source).toBe('verified_domain');
    });

    // ─────────────────────────────────────────────────────────────────
    // Brand-hierarchy traversal — auto-link follows brands.house_domain
    // when the user's email domain is a child of a paying org's verified
    // domain. Real-world example: AnalyticsIQ employee with @analyticsiq.com
    // email auto-links to Alliant's paid org if the brand registry knows
    // about the parent/child relationship.
    // ─────────────────────────────────────────────────────────────────

    describe('brand hierarchy traversal', () => {
      const CHILD_DOMAIN = 'analyticsiq.test';
      const PARENT_DOMAIN = 'alliantdata.test';

      async function seedBrandHierarchy(opts: { confidence?: 'high' | 'low'; hierarchyOptIn?: boolean } = {}) {
        // Parent: paying org with verified parent domain.
        await seedOrgWithVerifiedDomain(PARENT_DOMAIN);
        // Hierarchical inheritance is opt-in (default false). Most tests
        // here exercise the on-path so they enable it; "opt-in is required"
        // tests below leave it off.
        if (opts.hierarchyOptIn !== false) {
          await pool.query(
            `UPDATE organizations SET auto_provision_brand_hierarchy_children = true
               WHERE workos_organization_id = $1`,
            [TEST_AUTOLINK_ORG_ID],
          );
        }
        // Brand registry: child.com points up to parent.com via house_domain.
        await pool.query(
          `INSERT INTO brands (domain, brand_name, house_domain, source_type, brand_manifest, last_validated, created_at, updated_at)
           VALUES ($1, 'AnalyticsIQ', $2, 'enriched', $3, NOW(), NOW(), NOW())
           ON CONFLICT (domain) DO UPDATE
             SET house_domain = EXCLUDED.house_domain,
                 brand_manifest = EXCLUDED.brand_manifest,
                 last_validated = EXCLUDED.last_validated`,
          [
            CHILD_DOMAIN,
            PARENT_DOMAIN,
            JSON.stringify({ classification: { confidence: opts.confidence ?? 'high' } }),
          ],
        );
      }

      async function clearBrandHierarchy() {
        await pool.query('DELETE FROM brands WHERE domain IN ($1, $2)', [CHILD_DOMAIN, PARENT_DOMAIN]);
      }

      beforeEach(async () => {
        await clearBrandHierarchy();
      });

      afterAll(async () => {
        await clearBrandHierarchy();
      });

      it('links @child.com user to parent when org has opted into hierarchical auto-provisioning', async () => {
        await seedBrandHierarchy();
        const workos = makeWorkOSMock();

        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).not.toBeNull();
        expect(result!.organizationId).toBe(TEST_AUTOLINK_ORG_ID);
        expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith({
          userId: AUTOLINK_USER,
          organizationId: TEST_AUTOLINK_ORG_ID,
          roleSlug: 'member',
        });
      });

      it('does NOT auto-link via hierarchy by default (auto_provision_brand_hierarchy_children = false)', async () => {
        // Parent has direct auto-provisioning on (default), but no opt-in
        // for hierarchical children. This is the SaaS-norm default.
        await seedBrandHierarchy({ hierarchyOptIn: false });
        const workos = makeWorkOSMock();

        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).toBeNull();
        expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
      });

      it('does not traverse low-confidence classifications', async () => {
        await seedBrandHierarchy({ confidence: 'low' });
        const workos = makeWorkOSMock();

        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).toBeNull();
        expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
      });

      it('still requires the hierarchy opt-in even when direct auto-provisioning is enabled', async () => {
        // Direct=true, hierarchy=false (the default). Hierarchical match
        // should still be denied — the flags are independent.
        await seedBrandHierarchy({ hierarchyOptIn: false });
        await pool.query(
          `UPDATE organizations SET auto_provision_verified_domain = true
             WHERE workos_organization_id = $1`,
          [TEST_AUTOLINK_ORG_ID],
        );
        const workos = makeWorkOSMock();

        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).toBeNull();
        expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
      });

      it('honors direct auto-provisioning opt-out independently for direct matches', async () => {
        // Direct=false (opt-out), hierarchy=true. A user matching the
        // child via hierarchy still gets in.
        await seedBrandHierarchy();
        await pool.query(
          `UPDATE organizations SET auto_provision_verified_domain = false
             WHERE workos_organization_id = $1`,
          [TEST_AUTOLINK_ORG_ID],
        );
        const workos = makeWorkOSMock();

        // Hierarchical match still works.
        const inheritedResult = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);
        expect(inheritedResult).not.toBeNull();
      });

      it('short-circuits when the user is already in the resolved parent org', async () => {
        await seedBrandHierarchy();
        await pool.query(
          `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, seat_type, created_at, updated_at, synced_at)
           VALUES ($1, $2, $3, 'member', 'community_only', NOW(), NOW(), NOW())`,
          [AUTOLINK_USER, TEST_AUTOLINK_ORG_ID, `mike@${CHILD_DOMAIN}`],
        );
        const workos = makeWorkOSMock();

        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).toBeNull();
        expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
      });

      it('grandfather: skips users whose users.created_at predates the hierarchy opt-in', async () => {
        // Parent enabled the flag at T1. A user whose account was created
        // BEFORE T1 must NOT be auto-linked (would be retroactive backfill).
        // A user created AFTER T1 (or with no users row yet) IS auto-linked.
        await seedBrandHierarchy({ hierarchyOptIn: false }); // start opted out

        // Pre-existing user, created before flag flip.
        await pool.query(
          `INSERT INTO users (workos_user_id, email, created_at, updated_at)
           VALUES ($1, $2, NOW() - INTERVAL '1 day', NOW())
           ON CONFLICT (workos_user_id) DO UPDATE SET created_at = EXCLUDED.created_at`,
          [AUTOLINK_USER, `mike@${CHILD_DOMAIN}`],
        );

        // Now flip the flag on. The trigger sets auto_provision_hierarchy_enabled_at = NOW().
        await pool.query(
          `UPDATE organizations SET auto_provision_brand_hierarchy_children = true
             WHERE workos_organization_id = $1`,
          [TEST_AUTOLINK_ORG_ID],
        );

        const workos = makeWorkOSMock();
        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        // User predates the opt-in → no auto-link (grandfather).
        expect(result).toBeNull();
        expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();

        // Cleanup
        await pool.query('DELETE FROM users WHERE workos_user_id = $1', [AUTOLINK_USER]);
      });

      it('cohort: still auto-links a NEW user (created after flag flip) via hierarchy', async () => {
        await seedBrandHierarchy({ hierarchyOptIn: false }); // start opted out
        // Flip flag at T0 (sets enabled_at = NOW()).
        await pool.query(
          `UPDATE organizations SET auto_provision_brand_hierarchy_children = true
             WHERE workos_organization_id = $1`,
          [TEST_AUTOLINK_ORG_ID],
        );
        // User created AFTER the flip (NOW + a small offset to be safe).
        await pool.query(
          `INSERT INTO users (workos_user_id, email, created_at, updated_at)
           VALUES ($1, $2, NOW() + INTERVAL '1 second', NOW())
           ON CONFLICT (workos_user_id) DO UPDATE SET created_at = EXCLUDED.created_at`,
          [AUTOLINK_USER, `mike@${CHILD_DOMAIN}`],
        );

        const workos = makeWorkOSMock();
        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).not.toBeNull();
        expect(result!.organizationId).toBe(TEST_AUTOLINK_ORG_ID);

        await pool.query('DELETE FROM users WHERE workos_user_id = $1', [AUTOLINK_USER]);
      });

      it('cohort: auto-links when no users row exists yet (just-created via webhook)', async () => {
        // Webhook race: autoLink fires before user.created webhook lands the
        // local users row. Don't block on a missing row — treat as new joiner.
        await seedBrandHierarchy(); // hierarchyOptIn defaults to true
        const workos = makeWorkOSMock();

        // Confirm no users row exists for this user.
        await pool.query('DELETE FROM users WHERE workos_user_id = $1', [AUTOLINK_USER]);

        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).not.toBeNull();
        expect(result!.organizationId).toBe(TEST_AUTOLINK_ORG_ID);
      });

      it('prefers a direct verified-domain match over a hierarchical one when both exist', async () => {
        // Direct match wins: even if the brand registry says child→parent,
        // an explicit organization_domains row on the child takes priority.
        await seedBrandHierarchy();
        // Add a SECOND org that owns CHILD_DOMAIN directly.
        const DIRECT_ORG = 'org_direct_match_test';
        await pool.query(
          `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
             VALUES ($1, 'Direct Match Corp', 'active', NOW(), NOW())
             ON CONFLICT (workos_organization_id) DO UPDATE SET subscription_status = 'active'`,
          [DIRECT_ORG],
        );
        await pool.query(
          `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
             VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
             ON CONFLICT (domain) DO UPDATE SET verified = true, workos_organization_id = $1`,
          [DIRECT_ORG, CHILD_DOMAIN],
        );

        const workos = makeWorkOSMock();
        const result = await autoLinkByVerifiedDomain(workos, AUTOLINK_USER, `mike@${CHILD_DOMAIN}`);

        expect(result).not.toBeNull();
        expect(result!.organizationId).toBe(DIRECT_ORG);

        // Cleanup
        await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [DIRECT_ORG]);
        await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [DIRECT_ORG]);
      });
    });
  });

  describe('Auto-provision digest queries', () => {
    const DIGEST_ORG_ID = 'org_digest_test';
    const DIGEST_USER_NEW = 'user_digest_new';
    const DIGEST_USER_OLD = 'user_digest_old';
    const DIGEST_USER_INVITED = 'user_digest_invited';

    beforeEach(async () => {
      await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [DIGEST_ORG_ID]);
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [DIGEST_ORG_ID]);
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, is_personal, subscription_status, auto_provision_verified_domain, last_auto_provision_digest_sent_at, created_at, updated_at)
         VALUES ($1, 'Digest Test Org', false, 'active', true, $2, NOW(), NOW())`,
        [DIGEST_ORG_ID, new Date('2026-04-01T00:00:00Z')],
      );
    });

    afterAll(async () => {
      await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [DIGEST_ORG_ID]);
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [DIGEST_ORG_ID]);
    });

    async function seedMember(opts: {
      userId: string;
      email: string;
      source: 'verified_domain' | 'invited' | 'admin_added';
      createdAt: Date;
    }) {
      await pool.query(
        `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, email, role, seat_type, provisioning_source, created_at, updated_at, synced_at)
         VALUES ($1, $2, $3, 'member', 'community_only', $4, $5, $5, $5)`,
        [opts.userId, DIGEST_ORG_ID, opts.email, opts.source, opts.createdAt],
      );
    }

    it('finds orgs with new verified_domain members since the watermark', async () => {
      // Member joined BEFORE watermark — excluded.
      await seedMember({
        userId: DIGEST_USER_OLD,
        email: 'old@digest.com',
        source: 'verified_domain',
        createdAt: new Date('2026-03-15T00:00:00Z'),
      });
      // Member joined AFTER watermark — included.
      await seedMember({
        userId: DIGEST_USER_NEW,
        email: 'new@digest.com',
        source: 'verified_domain',
        createdAt: new Date('2026-04-15T00:00:00Z'),
      });
      // Invited member — wrong source, excluded.
      await seedMember({
        userId: DIGEST_USER_INVITED,
        email: 'invited@digest.com',
        source: 'invited',
        createdAt: new Date('2026-04-15T00:00:00Z'),
      });

      const rows = await findOrgsWithNewAutoProvisionedMembers();
      const target = rows.find(r => r.workos_organization_id === DIGEST_ORG_ID);
      expect(target).toBeDefined();
      expect(target!.new_member_count).toBe(1);
      expect(target!.org_name).toBe('Digest Test Org');
    });

    it('skips orgs with auto_provision_verified_domain disabled', async () => {
      await pool.query(
        'UPDATE organizations SET auto_provision_verified_domain = false WHERE workos_organization_id = $1',
        [DIGEST_ORG_ID],
      );
      await seedMember({
        userId: DIGEST_USER_NEW,
        email: 'new@digest.com',
        source: 'verified_domain',
        createdAt: new Date('2026-04-15T00:00:00Z'),
      });

      const rows = await findOrgsWithNewAutoProvisionedMembers();
      expect(rows.find(r => r.workos_organization_id === DIGEST_ORG_ID)).toBeUndefined();
    });

    it('skips orgs with no new members since watermark', async () => {
      await seedMember({
        userId: DIGEST_USER_OLD,
        email: 'old@digest.com',
        source: 'verified_domain',
        createdAt: new Date('2026-03-15T00:00:00Z'), // before watermark
      });

      const rows = await findOrgsWithNewAutoProvisionedMembers();
      expect(rows.find(r => r.workos_organization_id === DIGEST_ORG_ID)).toBeUndefined();
    });

    it('treats NULL watermark as the beginning of time', async () => {
      await pool.query(
        'UPDATE organizations SET last_auto_provision_digest_sent_at = NULL WHERE workos_organization_id = $1',
        [DIGEST_ORG_ID],
      );
      await seedMember({
        userId: DIGEST_USER_NEW,
        email: 'new@digest.com',
        source: 'verified_domain',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      const rows = await findOrgsWithNewAutoProvisionedMembers();
      const target = rows.find(r => r.workos_organization_id === DIGEST_ORG_ID);
      expect(target).toBeDefined();
      expect(target!.new_member_count).toBe(1);
      expect(target!.last_sent_at).toBeNull();
    });

    it('lists members chronologically, excluding non-verified-domain sources', async () => {
      const t1 = new Date('2026-04-10T00:00:00Z');
      const t2 = new Date('2026-04-12T00:00:00Z');
      const t3 = new Date('2026-04-14T00:00:00Z');

      await seedMember({ userId: 'u_b', email: 'b@digest.com', source: 'verified_domain', createdAt: t2 });
      await seedMember({ userId: 'u_a', email: 'a@digest.com', source: 'verified_domain', createdAt: t1 });
      await seedMember({ userId: 'u_c', email: 'c@digest.com', source: 'verified_domain', createdAt: t3 });
      await seedMember({ userId: 'u_inv', email: 'inv@digest.com', source: 'invited', createdAt: t2 });

      const members = await listNewAutoProvisionedMembers(DIGEST_ORG_ID, new Date('2026-04-01T00:00:00Z'));
      expect(members.map(m => m.email)).toEqual(['a@digest.com', 'b@digest.com', 'c@digest.com']);
    });

    it('markAutoProvisionDigestSent updates the watermark', async () => {
      const sent = new Date('2026-04-26T12:00:00Z');
      await markAutoProvisionDigestSent(DIGEST_ORG_ID, sent);
      const row = await pool.query<{ last_auto_provision_digest_sent_at: Date }>(
        'SELECT last_auto_provision_digest_sent_at FROM organizations WHERE workos_organization_id = $1',
        [DIGEST_ORG_ID],
      );
      expect(row.rows[0].last_auto_provision_digest_sent_at.toISOString()).toBe(sent.toISOString());
    });
  });

  describe('upsertOrganizationMembership provisioning_source', () => {
    it('writes provisioning_source on insert', async () => {
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_source_test',
        email: 'src@test.com',
        first_name: 'Src',
        last_name: 'Test',
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
        provisioning_source: 'verified_domain',
      });

      const row = await pool.query<{ provisioning_source: string | null }>(
        'SELECT provisioning_source FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].provisioning_source).toBe('verified_domain');
    });

    it('preserves an existing provisioning_source on subsequent upserts', async () => {
      // Initial insert tags the row.
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_pres_1',
        email: 'pres@test.com',
        first_name: null,
        last_name: null,
        role: 'member',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
        provisioning_source: 'admin_added',
      });

      // Subsequent webhook upsert with a less-specific source must not overwrite.
      await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_pres_1',
        email: 'pres@test.com',
        first_name: null,
        last_name: null,
        role: 'admin',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
        provisioning_source: 'webhook',
      });

      const row = await pool.query<{ provisioning_source: string | null; role: string }>(
        'SELECT provisioning_source, role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].provisioning_source).toBe('admin_added');
      // Role still updates normally.
      expect(row.rows[0].role).toBe('admin');
    });
  });
});
