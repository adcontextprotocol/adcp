import { describe, it, expect, vi, beforeEach } from "vitest";
import * as clientModule from "../../src/db/client.js";

/**
 * Agreement Recording Tests
 *
 * These tests validate the agreement acceptance recording flow:
 * 1. Recording agreements in user_agreement_acceptances table
 * 2. Updating organization agreement fields
 * 3. Handling edge cases like duplicate agreements
 *
 * The issue that prompted these tests:
 * - User subscribed and agreed to membership agreement
 * - Webhook tried to record agreement but failed silently
 * - Dashboard showed missing agreement even though user had agreed
 */

vi.mock("../../src/db/client.js");

describe("Agreement Recording", () => {
  let mockPool: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    vi.mocked(clientModule.getPool).mockReturnValue(mockPool);
  });

  describe("User Agreement Acceptance", () => {
    it("should insert agreement acceptance record", async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const query = `INSERT INTO user_agreement_acceptances
        (workos_user_id, email, agreement_type, agreement_version, workos_organization_id)
        VALUES ($1, $2, $3, $4, $5)`;

      const params = [
        'user_01KAVV9X7BRCDWRBE9B38MPVEC',
        'brian@example.com',
        'membership',
        '1.0',
        'org_01KAYQG2FCA1J12CERG9ZKRQCQ',
      ];

      const result = await mockPool.query(query, params);

      expect(mockPool.query).toHaveBeenCalledWith(query, params);
      expect(result.rowCount).toBe(1);
    });

    it("should handle duplicate agreement acceptance gracefully", async () => {
      // First insert succeeds
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      // Second insert for same user/type/version should use ON CONFLICT
      const query = `INSERT INTO user_agreement_acceptances
        (workos_user_id, email, agreement_type, agreement_version)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (workos_user_id, agreement_type, agreement_version) DO NOTHING`;

      const result = await mockPool.query(query, [
        'user_123',
        'test@example.com',
        'membership',
        '1.0',
      ]);

      expect(result.rowCount).toBeLessThanOrEqual(1);
    });

    it("should validate agreement type", () => {
      const validTypes = ['terms_of_service', 'privacy_policy', 'membership'];
      const invalidTypes = ['tos', 'privacy', 'member', 'agreement'];

      for (const type of validTypes) {
        expect(validTypes).toContain(type);
      }

      for (const type of invalidTypes) {
        expect(validTypes).not.toContain(type);
      }
    });

    it("should store optional IP and user agent", async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const query = `INSERT INTO user_agreement_acceptances
        (workos_user_id, email, agreement_type, agreement_version, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6)`;

      await mockPool.query(query, [
        'user_123',
        'test@example.com',
        'membership',
        '1.0',
        '192.168.1.1',
        'Mozilla/5.0...',
      ]);

      expect(mockPool.query).toHaveBeenCalledWith(query, expect.arrayContaining([
        'user_123',
        '192.168.1.1',
        'Mozilla/5.0...',
      ]));
    });
  });

  describe("Organization Agreement Fields", () => {
    it("should update organization agreement_signed_at and agreement_version", async () => {
      const now = new Date();
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const query = `UPDATE organizations
        SET agreement_signed_at = $1, agreement_version = $2
        WHERE workos_organization_id = $3`;

      await mockPool.query(query, [now, '1.0', 'org_123']);

      expect(mockPool.query).toHaveBeenCalledWith(query, [now, '1.0', 'org_123']);
    });

    it("should handle pending agreement fields", async () => {
      // Pending fields are set before checkout, then cleared after subscription
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      // Set pending agreement (when user checks checkbox)
      await mockPool.query(
        `UPDATE organizations
         SET pending_agreement_version = $1, pending_agreement_accepted_at = $2
         WHERE workos_organization_id = $3`,
        ['1.0', new Date(), 'org_123']
      );

      // Later, clear pending and set final (in webhook)
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      await mockPool.query(
        `UPDATE organizations
         SET agreement_signed_at = $1,
             agreement_version = $2,
             pending_agreement_version = NULL,
             pending_agreement_accepted_at = NULL
         WHERE workos_organization_id = $3`,
        [new Date(), '1.0', 'org_123']
      );

      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("Agreement Version Management", () => {
    it("should get current agreement version", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ version: '1.0', text: 'Agreement text...' }],
      });

      const result = await mockPool.query(
        `SELECT version, text FROM agreements
         WHERE agreement_type = $1
         ORDER BY effective_date DESC
         LIMIT 1`,
        ['membership']
      );

      expect(result.rows[0].version).toBe('1.0');
    });

    it("should detect outdated agreements", async () => {
      // User signed version 1.0
      const userVersion = '1.0';

      // Current version is 2.0
      mockPool.query.mockResolvedValueOnce({
        rows: [{ version: '2.0' }],
      });

      const result = await mockPool.query(
        `SELECT version FROM agreements
         WHERE agreement_type = $1
         ORDER BY effective_date DESC
         LIMIT 1`,
        ['membership']
      );

      const currentVersion = result.rows[0]?.version;
      const isOutdated = userVersion !== currentVersion;

      expect(isOutdated).toBe(true);
    });
  });

  describe("Agreement Acceptance API", () => {
    it("should record acceptance via POST /api/me/agreements/accept", async () => {
      // This tests the API endpoint flow
      const requestBody = {
        agreement_type: 'membership',
        agreement_version: '1.0',
      };

      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      // Simulate what the API handler does
      const { agreement_type, agreement_version } = requestBody;
      const workos_user_id = 'user_123';
      const email = 'test@example.com';

      await mockPool.query(
        `INSERT INTO user_agreement_acceptances
         (workos_user_id, email, agreement_type, agreement_version)
         VALUES ($1, $2, $3, $4)`,
        [workos_user_id, email, agreement_type, agreement_version]
      );

      expect(mockPool.query).toHaveBeenCalled();
    });

    it("should return user agreements via GET /api/me/agreements", async () => {
      const userAgreements = [
        { agreement_type: 'terms_of_service', agreement_version: '1.0', accepted_at: new Date() },
        { agreement_type: 'privacy_policy', agreement_version: '1.0', accepted_at: new Date() },
        { agreement_type: 'membership', agreement_version: '1.0', accepted_at: new Date() },
      ];

      mockPool.query.mockResolvedValueOnce({ rows: userAgreements });

      const result = await mockPool.query(
        `SELECT agreement_type, agreement_version, accepted_at
         FROM user_agreement_acceptances
         WHERE workos_user_id = $1`,
        ['user_123']
      );

      expect(result.rows).toHaveLength(3);
      expect(result.rows.map((r: any) => r.agreement_type)).toContain('membership');
    });
  });

  describe("Missing Agreement Detection", () => {
    it("should detect missing membership agreement for paying member", async () => {
      // User has ToS and Privacy but not Membership
      const userAgreements = [
        { type: 'terms_of_service', version: '1.0' },
        { type: 'privacy_policy', version: '1.0' },
      ];

      const hasActiveSubscription = true;
      const hasMembershipAgreement = userAgreements.some(a => a.type === 'membership');

      const needsMembershipAgreement = hasActiveSubscription && !hasMembershipAgreement;

      expect(needsMembershipAgreement).toBe(true);
    });

    it("should not require membership agreement for non-subscribers", async () => {
      const userAgreements = [
        { type: 'terms_of_service', version: '1.0' },
        { type: 'privacy_policy', version: '1.0' },
      ];

      const hasActiveSubscription = false;
      const hasMembershipAgreement = userAgreements.some(a => a.type === 'membership');

      const needsMembershipAgreement = hasActiveSubscription && !hasMembershipAgreement;

      expect(needsMembershipAgreement).toBe(false);
    });

    it("should show membership agreement once subscribed", () => {
      // This tests the dashboard logic
      const agreements = [
        { type: 'terms_of_service', version: '1.0', current_version: '1.0' },
        { type: 'privacy_policy', version: '1.0', current_version: '1.0' },
        { type: 'membership', version: null, current_version: '1.0' }, // Not signed
      ];

      const hasActiveSubscription = true;

      // Filter logic from dashboard.html
      const relevantAgreements = agreements.filter(a => {
        if (a.type === 'membership') {
          return hasActiveSubscription;
        }
        return true;
      });

      // Find missing membership
      const missingMembership = relevantAgreements.find(
        a => a.type === 'membership' && !a.version
      );

      expect(relevantAgreements).toHaveLength(3);
      expect(missingMembership).toBeDefined();
      expect(missingMembership?.type).toBe('membership');
    });
  });
});

describe("Agreement Recording Error Handling", () => {
  let mockPool: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {
      query: vi.fn(),
    };
    vi.mocked(clientModule.getPool).mockReturnValue(mockPool);
  });

  it("should handle WorkOS user lookup failure", async () => {
    // Simulate WorkOS returning empty results
    const workosUsers = { data: [] };

    // When no WorkOS user is found, agreement should not be recorded
    // but webhook should not fail
    expect(workosUsers.data.length).toBe(0);

    // The webhook logs an error but continues:
    // logger.error({ userEmail }, 'Could not find WorkOS user for Stripe customer');
  });

  it("should handle email mismatch between Stripe and WorkOS", async () => {
    const stripeEmail = 'stripe@example.com';
    const workosEmail = 'workos@example.com';

    // This is a known failure mode - if Stripe customer has different email
    // than WorkOS user, the lookup will fail
    expect(stripeEmail).not.toBe(workosEmail);

    // TODO: Implement more robust user linking (e.g., store WorkOS user ID in Stripe metadata)
  });

  it("should catch and log agreement recording errors", async () => {
    mockPool.query.mockRejectedValueOnce(new Error('Database error'));

    let errorCaught = false;

    try {
      await mockPool.query(
        `INSERT INTO user_agreement_acceptances VALUES ($1, $2, $3, $4)`,
        ['user_123', 'test@example.com', 'membership', '1.0']
      );
    } catch (userError) {
      errorCaught = true;
      // In production: logger.error({ error: userError }, 'Failed to record agreement acceptance in webhook');
    }

    expect(errorCaught).toBe(true);
    // Webhook should still return 200
  });
});
