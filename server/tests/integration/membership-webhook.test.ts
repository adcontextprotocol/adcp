/**
 * Membership webhook integration tests
 *
 * Exercises the actual SQL queries in membership-db against a real PostgreSQL
 * instance. Catches type-inference bugs (like the varchar/text mismatch that
 * broke all organization_membership webhooks in production).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  upsertOrganizationMembership,
  deleteOrganizationMembership,
  consumeInvitationSeatType,
  findSuccessorForPromotion,
  setMembershipRole,
} from '../../src/db/membership-db.js';
import type { Pool } from 'pg';

const TEST_ORG_ID = 'org_webhook_membership_test';
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
});
