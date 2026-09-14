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
  resolveRoleWithWorkosFirstPromote,
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
    it('writes the role it is given (no DB-side auto-promote)', async () => {
      // Auto-promote moved to the webhook handler so WorkOS is written
      // before local — upsert is now a pure mirror function.
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

      expect(result.assigned_role).toBe('member');

      const row = await pool.query(
        'SELECT role, email, seat_type FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [TEST_USER_1, TEST_ORG_ID],
      );
      expect(row.rows[0].role).toBe('member');
      expect(row.rows[0].email).toBe('alice@test.com');
      expect(row.rows[0].seat_type).toBe('community_only');
    });

    it('writes owner when owner is passed in', async () => {
      const result = await upsertOrganizationMembership({
        user_id: TEST_USER_1,
        organization_id: TEST_ORG_ID,
        membership_id: 'om_test_1',
        email: 'alice@test.com',
        first_name: 'Alice',
        last_name: 'Test',
        role: 'owner',
        seat_type: 'community_only',
        has_explicit_seat_type: false,
      });

      expect(result.assigned_role).toBe('owner');
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
  // RESOLVE ROLE (WorkOS-first auto-promote)
  // =========================================================================

  describe('ordinary membership role preservation', () => {
    it.each(['member', 'admin', 'owner'])('preserves provider role %s without provider calls', async (incomingRole) => {
      const workos = { userManagement: {
        listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }),
        updateOrganizationMembership: vi.fn(),
      }};
      const result = await resolveRoleWithWorkosFirstPromote({
        workos: workos as unknown as WorkOS, membershipId: 'om_exact',
        userId: TEST_USER_1, organizationId: TEST_ORG_ID, incomingRole,
      });
      expect(result).toEqual({ role: incomingRole, promoted: false });
      expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
      expect(workos.userManagement.updateOrganizationMembership).not.toHaveBeenCalled();
    });
  });

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

  describe('domain auto-link containment', () => {
    it.each(['member@acme.test', ' MEMBER@ACME.TEST ', 'member@子.test', '', 'invalid'])('does not provision from %s', async (email) => {
      const workos = { userManagement: { createOrganizationMembership: vi.fn() }};
      const before = await pool.query('SELECT COUNT(*) FROM organization_memberships');
      const stagedBefore = await pool.query('SELECT COUNT(*) FROM invitation_seat_types');
      expect(await autoLinkByVerifiedDomain(workos as unknown as WorkOS, TEST_USER_1, email)).toBeNull();
      expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled();
      expect((await pool.query('SELECT COUNT(*) FROM organization_memberships')).rows).toEqual(before.rows);
      expect((await pool.query('SELECT COUNT(*) FROM invitation_seat_types')).rows).toEqual(stagedBefore.rows);
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
