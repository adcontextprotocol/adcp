/**
 * Seat Lifecycle Integration Tests
 *
 * Tests the seat upgrade request schema, warning thresholds, and hysteresis logic
 * against a real PostgreSQL database. HTTP endpoint tests are covered by unit tests
 * since the full HTTP stack requires complex WorkOS mock setup.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  checkAndUpdateSeatWarning,
  resetSeatWarningIfNeeded,
  createSeatUpgradeRequest,
  getSeatUpgradeRequest,
  listSeatUpgradeRequests,
  resolveSeatUpgradeRequest,
  hasPendingSeatRequest,
  findStaleSeatRequests,
  markAdminReminderSent,
  markMemberTimeoutNotified,
  getSeatUsage,
  getSeatLimits,
} from '../../src/db/organization-db.js';
import type { Pool } from 'pg';

const TEST_ORG_ID = 'org_seat_lifecycle_test';
const TEST_MEMBER_USER_ID = 'user_seat_member_1';
const TEST_ADMIN_USER_ID = 'user_seat_admin_1';

describe('Seat Lifecycle', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM seat_upgrade_requests WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clean test data
    await pool.query('DELETE FROM seat_upgrade_requests WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);

    // Set up test org with company_standard tier (5 contributor, 5 community)
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, membership_tier, subscription_status, created_at, updated_at)
       VALUES ($1, $2, false, 'company_standard', 'active', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET
         membership_tier = 'company_standard', subscription_status = 'active',
         last_contributor_seat_warning = 0, last_community_seat_warning = 0`,
      [TEST_ORG_ID, 'Seat Test Org']
    );
  });

  // =========================================================================
  // SEAT WARNING THRESHOLDS
  // =========================================================================

  describe('checkAndUpdateSeatWarning', () => {
    it('fires at 80% threshold', async () => {
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');
      expect(result).toEqual({ shouldNotify: true, threshold: 80 });
    });

    it('fires at 100% threshold', async () => {
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 5, 5, 'company_standard');
      expect(result).toEqual({ shouldNotify: true, threshold: 100 });
    });

    it('does not fire below 80%', async () => {
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 3, 5, 'company_standard');
      expect(result).toBeNull();
    });

    it('does not fire twice at same threshold (atomic)', async () => {
      await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');
      const second = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');
      expect(second).toBeNull();
    });

    it('fires 100% after 80% was already sent', async () => {
      await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 5, 5, 'company_standard');
      expect(result).toEqual({ shouldNotify: true, threshold: 100 });
    });

    it('excludes individual tiers', async () => {
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 1, 1, 'individual_professional');
      expect(result).toBeNull();
    });

    it('skips unlimited seat types', async () => {
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'community', 100, -1, 'company_leader');
      expect(result).toBeNull();
    });

    it('hysteresis: re-arms at 60%', async () => {
      // Fire at 80%
      await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');

      // Drop to 59% (2/5) — should re-arm
      await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 2, 5, 'company_standard');

      // Go back to 80% — should fire again
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');
      expect(result).toEqual({ shouldNotify: true, threshold: 80 });
    });

    it('hysteresis: does NOT re-arm at 60% exactly', async () => {
      // Fire at 80%
      await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');

      // Stay at 60% (3/5) — should NOT re-arm
      await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 3, 5, 'company_standard');

      // Go back to 80% — should NOT fire
      const result = await checkAndUpdateSeatWarning(TEST_ORG_ID, 'contributor', 4, 5, 'company_standard');
      expect(result).toBeNull();
    });
  });

  describe('resetSeatWarningIfNeeded', () => {
    it('returns previous threshold when seat frees up', async () => {
      // Set threshold to 80
      await pool.query(
        'UPDATE organizations SET last_contributor_seat_warning = 80 WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      const oldThreshold = await resetSeatWarningIfNeeded(TEST_ORG_ID, 'contributor', 2, 5);
      expect(oldThreshold).toBe(80);
    });
  });

  // =========================================================================
  // SEAT UPGRADE REQUESTS — DB LAYER
  // =========================================================================

  describe('createSeatUpgradeRequest', () => {
    it('creates a request with correct fields', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
        resourceId: 'wg_test_1',
        resourceName: 'Protocol WG',
      });

      expect(req.id).toBeDefined();
      expect(req.status).toBe('pending');
      expect(req.workos_organization_id).toBe(TEST_ORG_ID);
      expect(req.workos_user_id).toBe(TEST_MEMBER_USER_ID);
      expect(req.resource_type).toBe('working_group');
      expect(req.resource_name).toBe('Protocol WG');
    });

    it('rejects duplicate pending request for same resource', async () => {
      await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
        resourceId: 'wg_dup',
      });

      await expect(createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
        resourceId: 'wg_dup',
      })).rejects.toThrow();
    });

    it('allows requests for different resource types', async () => {
      await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
        resourceId: 'wg_a',
      });

      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'council',
        resourceId: 'council_b',
      });

      expect(req.id).toBeDefined();
    });
  });

  describe('resolveSeatUpgradeRequest', () => {
    it('approves a pending request', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
      });

      const resolved = await resolveSeatUpgradeRequest(req.id, 'approved', TEST_ADMIN_USER_ID);
      expect(resolved?.status).toBe('approved');
      expect(resolved?.resolved_by).toBe(TEST_ADMIN_USER_ID);
      expect(resolved?.resolved_at).not.toBeNull();
    });

    it('denies a pending request', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'council',
      });

      const resolved = await resolveSeatUpgradeRequest(req.id, 'denied', TEST_ADMIN_USER_ID);
      expect(resolved?.status).toBe('denied');
    });

    it('returns null for already-resolved request', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'product_summit',
      });

      await resolveSeatUpgradeRequest(req.id, 'approved', TEST_ADMIN_USER_ID);
      const second = await resolveSeatUpgradeRequest(req.id, 'denied', TEST_ADMIN_USER_ID);
      expect(second).toBeNull();
    });

    it('allows new request after previous one is resolved', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
        resourceId: 'wg_resubmit',
      });

      await resolveSeatUpgradeRequest(req.id, 'denied', TEST_ADMIN_USER_ID);

      const req2 = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
        resourceId: 'wg_resubmit',
      });
      expect(req2.id).toBeDefined();
      expect(req2.id).not.toBe(req.id);
    });
  });

  describe('hasPendingSeatRequest', () => {
    it('returns true when pending request exists', async () => {
      await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
        resourceId: 'wg_check',
      });

      const has = await hasPendingSeatRequest(TEST_ORG_ID, TEST_MEMBER_USER_ID, 'working_group', 'wg_check');
      expect(has).toBe(true);
    });

    it('returns false when no pending request', async () => {
      const has = await hasPendingSeatRequest(TEST_ORG_ID, TEST_MEMBER_USER_ID, 'working_group', 'wg_nonexistent');
      expect(has).toBe(false);
    });

    it('returns false after request is resolved', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'council',
        resourceId: 'council_resolved',
      });

      await resolveSeatUpgradeRequest(req.id, 'approved', TEST_ADMIN_USER_ID);

      const has = await hasPendingSeatRequest(TEST_ORG_ID, TEST_MEMBER_USER_ID, 'council', 'council_resolved');
      expect(has).toBe(false);
    });
  });

  describe('listSeatUpgradeRequests', () => {
    it('lists pending requests for an org', async () => {
      await createSeatUpgradeRequest({ orgId: TEST_ORG_ID, userId: TEST_MEMBER_USER_ID, resourceType: 'working_group' });
      await createSeatUpgradeRequest({ orgId: TEST_ORG_ID, userId: TEST_MEMBER_USER_ID, resourceType: 'council' });

      const requests = await listSeatUpgradeRequests(TEST_ORG_ID, { status: 'pending' });
      expect(requests.length).toBe(2);
    });

    it('filters by user', async () => {
      await createSeatUpgradeRequest({ orgId: TEST_ORG_ID, userId: TEST_MEMBER_USER_ID, resourceType: 'working_group' });
      await createSeatUpgradeRequest({ orgId: TEST_ORG_ID, userId: 'user_other', resourceType: 'council' });

      const requests = await listSeatUpgradeRequests(TEST_ORG_ID, { userId: TEST_MEMBER_USER_ID });
      expect(requests.length).toBe(1);
      expect(requests[0].workos_user_id).toBe(TEST_MEMBER_USER_ID);
    });
  });

  describe('findStaleSeatRequests', () => {
    it('finds requests older than 48h for admin reminder', async () => {
      // Insert a request 3 days old
      await pool.query(
        `INSERT INTO seat_upgrade_requests (workos_organization_id, workos_user_id, resource_type, created_at)
         VALUES ($1, $2, 'working_group', NOW() - INTERVAL '3 days')`,
        [TEST_ORG_ID, TEST_MEMBER_USER_ID]
      );

      const { needsAdminReminder } = await findStaleSeatRequests();
      expect(needsAdminReminder.length).toBeGreaterThanOrEqual(1);
    });

    it('finds requests older than 7 days for member timeout', async () => {
      await pool.query(
        `INSERT INTO seat_upgrade_requests (workos_organization_id, workos_user_id, resource_type, created_at)
         VALUES ($1, $2, 'council', NOW() - INTERVAL '8 days')`,
        [TEST_ORG_ID, TEST_MEMBER_USER_ID]
      );

      const { needsMemberTimeout } = await findStaleSeatRequests();
      expect(needsMemberTimeout.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes requests with reminders already sent', async () => {
      const result = await pool.query(
        `INSERT INTO seat_upgrade_requests (workos_organization_id, workos_user_id, resource_type, created_at, admin_reminder_sent_at)
         VALUES ($1, $2, 'product_summit', NOW() - INTERVAL '3 days', NOW())
         RETURNING id`,
        [TEST_ORG_ID, TEST_MEMBER_USER_ID]
      );

      const { needsAdminReminder } = await findStaleSeatRequests();
      const ids = needsAdminReminder.map(r => r.id);
      expect(ids).not.toContain(result.rows[0].id);
    });
  });

  describe('markAdminReminderSent / markMemberTimeoutNotified', () => {
    it('sets admin_reminder_sent_at', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'working_group',
      });

      await markAdminReminderSent(req.id);

      const updated = await getSeatUpgradeRequest(req.id);
      expect(updated?.admin_reminder_sent_at).not.toBeNull();
    });

    it('sets member_timeout_notified_at', async () => {
      const req = await createSeatUpgradeRequest({
        orgId: TEST_ORG_ID,
        userId: TEST_MEMBER_USER_ID,
        resourceType: 'council',
      });

      await markMemberTimeoutNotified(req.id);

      const updated = await getSeatUpgradeRequest(req.id);
      expect(updated?.member_timeout_notified_at).not.toBeNull();
    });
  });

  // =========================================================================
  // SEAT LIMITS INTEGRATION
  // =========================================================================

  describe('getSeatLimits integration', () => {
    it('company_standard has 5/5 limits', () => {
      expect(getSeatLimits('company_standard')).toEqual({ contributor: 5, community: 5 });
    });

    it('company_leader has unlimited community', () => {
      expect(getSeatLimits('company_leader')).toEqual({ contributor: 20, community: -1 });
    });
  });

  describe('getSeatUsage integration', () => {
    it('counts members by seat type', async () => {
      // Add members to test org
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'admin@test.com', 'contributor', NOW(), NOW(), NOW())
         ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
        [TEST_ADMIN_USER_ID, TEST_ORG_ID]
      );
      await pool.query(
        `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, seat_type, created_at, updated_at, synced_at)
         VALUES ($1, $2, 'member@test.com', 'community_only', NOW(), NOW(), NOW())
         ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
        [TEST_MEMBER_USER_ID, TEST_ORG_ID]
      );

      const usage = await getSeatUsage(TEST_ORG_ID);
      expect(usage.contributor).toBeGreaterThanOrEqual(1);
      expect(usage.community_only).toBeGreaterThanOrEqual(0);
    });
  });
});
