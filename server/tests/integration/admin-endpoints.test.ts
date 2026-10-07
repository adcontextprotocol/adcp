import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { getSlackUsers, getUserChannels, isSlackConfigured } from '../../src/slack/client.js';
import { syncSlackUsers } from '../../src/slack/sync.js';
import { SlackDatabase } from '../../src/db/slack-db.js';

// Keep sync, account linking, chapter sync and SQL real; control Slack transport.
vi.mock('../../src/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/slack/client.js')>()),
  isSlackConfigured: vi.fn().mockReturnValue(true),
  getSlackUsers: vi.fn().mockResolvedValue([]),
  getUserChannels: vi.fn().mockResolvedValue([]),
}));

// Override only the auth gates; spread the real module so HTTPServer setup
// still finds optionalAuth and other exports it imports.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_test_admin',
      email: 'admin@test.com',
      is_admin: true
    };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

// Mock Stripe client to control subscription checks
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

describe('Admin Endpoints Integration Tests', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  const TEST_ORG_ID = 'org_test_admin';
  const TEST_CUSTOMER_ID = 'cus_test_admin';

  beforeAll(async () => {
    // Initialize test database
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });

    // Run migrations
    await runMigrations();

    // Create test organization
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG_ID, 'Test Admin Org', TEST_CUSTOMER_ID]
    );

    // Initialize HTTP server
    server = new HTTPServer();
    await server.start(0); // Use port 0 for random port
    app = server.app;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM agreements WHERE TRUE');
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);

    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clean up agreements before each test
    await pool.query('DELETE FROM agreements WHERE TRUE');
  });

  describe('GET /api/admin/agreements', () => {
    it('should list all agreements without text', async () => {
      // Create a test agreement
      await pool.query(
        `INSERT INTO agreements (agreement_type, version, text, effective_date)
         VALUES ($1, $2, $3, $4)`,
        ['membership', '1.0', 'Test agreement content', new Date()]
      );

      const response = await request(app)
        .get('/api/admin/agreements')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0]).toHaveProperty('version');
      expect(response.body[0]).not.toHaveProperty('text');
    });
  });

  describe('GET /api/admin/agreements/:id', () => {
    it('should return a single agreement with full text', async () => {
      const result = await pool.query(
        `INSERT INTO agreements (agreement_type, version, text, effective_date)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['membership', '1.0', 'Full agreement text here', new Date()]
      );
      const id = result.rows[0].id;

      const response = await request(app)
        .get(`/api/admin/agreements/${id}`)
        .expect(200);

      expect(response.body).toHaveProperty('text', 'Full agreement text here');
      expect(response.body).toHaveProperty('version', '1.0');
    });

    it('should return 404 for non-existent agreement', async () => {
      await request(app)
        .get('/api/admin/agreements/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });

    it('should return 400 for invalid id format', async () => {
      await request(app)
        .get('/api/admin/agreements/not-a-uuid')
        .expect(400);
    });
  });

  describe('POST /api/admin/agreements', () => {
    it('should create a new agreement', async () => {
      const newAgreement = {
        agreement_type: 'membership',
        version: '2.0',
        text: 'New test agreement content',
        effective_date: new Date().toISOString(),
      };

      const response = await request(app)
        .post('/api/admin/agreements')
        .send(newAgreement)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.version).toBe('2.0');
      expect(response.body.text).toBe('New test agreement content');
    });
  });

  describe('PUT /api/admin/agreements/:id', () => {
    it('should update an existing agreement', async () => {
      // Create an agreement first
      const createResult = await pool.query(
        `INSERT INTO agreements (agreement_type, version, text, effective_date)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['membership', '1.0', 'Original content', new Date()]
      );
      const agreementId = createResult.rows[0].id;

      const updatedAgreement = {
        agreement_type: 'membership',
        version: '1.1',
        text: 'Updated content',
        effective_date: new Date().toISOString(),
      };

      const response = await request(app)
        .put(`/api/admin/agreements/${agreementId}`)
        .send(updatedAgreement)
        .expect(200);

      expect(response.body.version).toBe('1.1');
      expect(response.body.text).toBe('Updated content');
    });
  });

  describe('POST /api/admin/accounts/:orgId/sync', () => {
    it('should sync organization data from WorkOS and Stripe', async () => {
      // First check that organization exists and has subscription data
      const beforeSync = await pool.query(
        'SELECT subscription_amount, subscription_current_period_end FROM organizations WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      // Call the sync endpoint
      const response = await request(app)
        .post(`/api/admin/accounts/${TEST_ORG_ID}/sync`)
        .expect(200);

      // Check response structure
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('workos');
      expect(response.body).toHaveProperty('stripe');

      // WorkOS should succeed (even if no members, it's not a failure)
      expect(response.body.workos).toHaveProperty('success');

      // Stripe sync depends on whether TEST_ORG_ID has a stripe_customer_id
      expect(response.body.stripe).toHaveProperty('success');
    });

    it('should return 404 for non-existent organization', async () => {
      const response = await request(app)
        .post('/api/admin/accounts/org_nonexistent/sync')
        .expect(404);

      expect(response.body.error).toBe('Organization not found');
    });

    it('should handle WorkOS errors gracefully', async () => {
      // Create a test org without a real WorkOS organization
      const fakeOrgId = 'org_fake_for_sync_test';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO NOTHING`,
        [fakeOrgId, 'Fake Org for Sync Test']
      );

      const response = await request(app)
        .post(`/api/admin/accounts/${fakeOrgId}/sync`)
        .expect(200);

      // WorkOS should fail for non-existent org
      expect(response.body.workos.success).toBe(false);
      expect(response.body.workos.error).toBeDefined();

      // Clean up
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [fakeOrgId]);
    });
  });

  describe('DELETE /api/admin/accounts/:orgId', () => {
    const DELETE_TEST_ORG_ID = 'org_delete_test';
    const DELETE_TEST_PAID_ORG_ID = 'org_delete_test_paid';

    beforeEach(async () => {
      // Create test organizations for delete tests
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2`,
        [DELETE_TEST_ORG_ID, 'Delete Test Org']
      );

      // Create a paid organization with revenue events
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, stripe_customer_id, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, stripe_customer_id = $3`,
        [DELETE_TEST_PAID_ORG_ID, 'Paid Test Org', 'cus_paid_test']
      );

      // Add a revenue event for the paid org
      await pool.query(
        `INSERT INTO revenue_events (workos_organization_id, revenue_type, amount_paid, currency, paid_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [DELETE_TEST_PAID_ORG_ID, 'subscription_initial', 2999, 'usd']
      );
    });

    afterEach(async () => {
      // Clean up test data
      await pool.query('DELETE FROM revenue_events WHERE workos_organization_id = $1', [DELETE_TEST_PAID_ORG_ID]);
      await pool.query('DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)', [DELETE_TEST_ORG_ID, DELETE_TEST_PAID_ORG_ID]);
    });

    it('should return 404 for non-existent organization', async () => {
      const response = await request(app)
        .delete('/api/admin/accounts/org_nonexistent')
        .send({ confirmation: 'Some Name' })
        .expect(404);

      expect(response.body.error).toBe('Organization not found');
    });

    it('should require confirmation to delete', async () => {
      const response = await request(app)
        .delete(`/api/admin/accounts/${DELETE_TEST_ORG_ID}`)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Confirmation required');
      expect(response.body.requires_confirmation).toBe(true);
      expect(response.body.organization_name).toBe('Delete Test Org');
    });

    it('should reject wrong confirmation name', async () => {
      const response = await request(app)
        .delete(`/api/admin/accounts/${DELETE_TEST_ORG_ID}`)
        .send({ confirmation: 'Wrong Name' })
        .expect(400);

      expect(response.body.error).toBe('Confirmation required');
    });

    it('should prevent deletion of organization with payment history', async () => {
      const response = await request(app)
        .delete(`/api/admin/accounts/${DELETE_TEST_PAID_ORG_ID}`)
        .send({ confirmation: 'Paid Test Org' })
        .expect(400);

      expect(response.body.error).toBe('Cannot delete paid workspace');
      expect(response.body.has_payments).toBe(true);

      // Verify org still exists
      const checkResult = await pool.query(
        'SELECT 1 FROM organizations WHERE workos_organization_id = $1',
        [DELETE_TEST_PAID_ORG_ID]
      );
      expect(checkResult.rows.length).toBe(1);
    });

    it('should successfully delete unpaid organization with correct confirmation', async () => {
      const response = await request(app)
        .delete(`/api/admin/accounts/${DELETE_TEST_ORG_ID}`)
        .send({ confirmation: 'Delete Test Org' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.deleted_org_id).toBe(DELETE_TEST_ORG_ID);

      // Verify org is deleted
      const checkResult = await pool.query(
        'SELECT 1 FROM organizations WHERE workos_organization_id = $1',
        [DELETE_TEST_ORG_ID]
      );
      expect(checkResult.rows.length).toBe(0);
    });

    it('should cascade delete related member profiles', async () => {
      // Create a member profile for the test org
      await pool.query(
        `INSERT INTO member_profiles (workos_organization_id, display_name, slug, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [DELETE_TEST_ORG_ID, 'Test Profile', 'test-profile']
      );

      // Verify profile exists
      const beforeResult = await pool.query(
        'SELECT 1 FROM member_profiles WHERE workos_organization_id = $1',
        [DELETE_TEST_ORG_ID]
      );
      expect(beforeResult.rows.length).toBe(1);

      // Delete the organization
      await request(app)
        .delete(`/api/admin/accounts/${DELETE_TEST_ORG_ID}`)
        .send({ confirmation: 'Delete Test Org' })
        .expect(200);

      // Verify profile is cascaded deleted
      const afterResult = await pool.query(
        'SELECT 1 FROM member_profiles WHERE workos_organization_id = $1',
        [DELETE_TEST_ORG_ID]
      );
      expect(afterResult.rows.length).toBe(0);
    });

    // OrganizationDatabase.getSubscriptionInfo reads subscription_status from the DB row;
    // mocking the stripe-client import has no effect. Seed the column directly.
    // The active-subscription guard applies to admin-initiated deletes too; force-deletion
    // of a subscribed org requires a DB-level intervention (clear subscription_status).
    it('should prevent deletion of organization with active subscription', async () => {
      const SUB_ORG_ID = 'org_delete_test_sub';
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, subscription_status, created_at, updated_at)
         VALUES ($1, $2, 'active', NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET name = $2, subscription_status = 'active'`,
        [SUB_ORG_ID, 'Subscribed Test Org']
      );

      const response = await request(app)
        .delete(`/api/admin/accounts/${SUB_ORG_ID}`)
        .send({ confirmation: 'Subscribed Test Org' })
        .expect(400);

      expect(response.body.error).toBe('Cannot delete workspace with active subscription');
      expect(response.body.has_active_subscription).toBe(true);
      expect(response.body.subscription_status).toBe('active');

      // Verify org still exists
      const checkResult = await pool.query(
        'SELECT 1 FROM organizations WHERE workos_organization_id = $1',
        [SUB_ORG_ID]
      );
      expect(checkResult.rows.length).toBe(1);

      // SUB_ORG_ID is not covered by the inner afterEach; clean up inline.
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [SUB_ORG_ID]);
    });
  });

  describe('GET /api/admin/slack/auto-link-suggested', () => {
    const TEST_SLACK_USER_ID = 'U_test_slack_user';
    const TEST_SLACK_EMAIL = 'test-slack@example.com';

    beforeEach(async () => {
      // Clean up any existing test data
      await pool.query('DELETE FROM slack_user_mappings WHERE slack_user_id LIKE $1', ['U_test_%']);
    });

    afterEach(async () => {
      // Clean up test data
      await pool.query('DELETE FROM slack_user_mappings WHERE slack_user_id LIKE $1', ['U_test_%']);
    });

    it('should return empty suggestions when no unmapped Slack users exist', async () => {
      const response = await request(app)
        .get('/api/admin/slack/auto-link-suggested')
        .expect(200);

      expect(response.body).toHaveProperty('suggestions');
      expect(response.body.suggestions).toBeInstanceOf(Array);
    });

    it('should return suggestions array structure with correct fields', async () => {
      // Create an unmapped Slack user
      await pool.query(
        `INSERT INTO slack_user_mappings (
          slack_user_id, slack_email, slack_display_name, slack_real_name,
          slack_is_bot, slack_is_deleted, mapping_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [TEST_SLACK_USER_ID, TEST_SLACK_EMAIL, 'Test User', 'Test Real Name', false, false, 'unmapped']
      );

      const response = await request(app)
        .get('/api/admin/slack/auto-link-suggested')
        .expect(200);

      expect(response.body).toHaveProperty('suggestions');
      expect(response.body.suggestions).toBeInstanceOf(Array);

      // If there are suggestions, verify structure
      // (WorkOS integration may not return matches in test environment)
      if (response.body.suggestions.length > 0) {
        const suggestion = response.body.suggestions[0];
        expect(suggestion).toHaveProperty('slack_user_id');
        expect(suggestion).toHaveProperty('slack_email');
        expect(suggestion).toHaveProperty('slack_name');
        expect(suggestion).toHaveProperty('workos_user_id');
      }
    });

    it('should not include mapped Slack users in suggestions', async () => {
      // Create a mapped Slack user
      await pool.query(
        `INSERT INTO slack_user_mappings (
          slack_user_id, slack_email, slack_display_name, slack_real_name,
          slack_is_bot, slack_is_deleted, mapping_status, workos_user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [TEST_SLACK_USER_ID, TEST_SLACK_EMAIL, 'Test User', 'Test Real Name', false, false, 'mapped', 'user_already_mapped']
      );

      const response = await request(app)
        .get('/api/admin/slack/auto-link-suggested')
        .expect(200);

      // The mapped user should not appear in suggestions
      const matchingSuggestion = response.body.suggestions.find(
        (s: any) => s.slack_user_id === TEST_SLACK_USER_ID
      );
      expect(matchingSuggestion).toBeUndefined();
    });

    it('should not include bot users in suggestions', async () => {
      // Create a bot Slack user
      await pool.query(
        `INSERT INTO slack_user_mappings (
          slack_user_id, slack_email, slack_display_name, slack_real_name,
          slack_is_bot, slack_is_deleted, mapping_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['U_test_bot', 'bot@example.com', 'Bot User', 'Bot', true, false, 'unmapped']
      );

      const response = await request(app)
        .get('/api/admin/slack/auto-link-suggested')
        .expect(200);

      // Bot users should not appear in suggestions
      const matchingSuggestion = response.body.suggestions.find(
        (s: any) => s.slack_user_id === 'U_test_bot'
      );
      expect(matchingSuggestion).toBeUndefined();
    });

    it('should not include deleted users in suggestions', async () => {
      // Create a deleted Slack user
      await pool.query(
        `INSERT INTO slack_user_mappings (
          slack_user_id, slack_email, slack_display_name, slack_real_name,
          slack_is_bot, slack_is_deleted, mapping_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['U_test_deleted', 'deleted@example.com', 'Deleted User', 'Deleted', false, true, 'unmapped']
      );

      const response = await request(app)
        .get('/api/admin/slack/auto-link-suggested')
        .expect(200);

      // Deleted users should not appear in suggestions
      const matchingSuggestion = response.body.suggestions.find(
        (s: any) => s.slack_user_id === 'U_test_deleted'
      );
      expect(matchingSuggestion).toBeUndefined();
    });
  });

  describe('POST /api/admin/slack/auto-link-suggested', () => {
    const ownedFixtures: Array<{ slackId: string; userId: string; orgId: string; email: string }> = [];
    const ownedSlackIds = new Set<string>();

    async function createOwnedMember() {
      const id = randomUUID().replaceAll('-', '');
      const fixture = {
        slackId: `UHTTP${id.toUpperCase()}`,
        userId: `user_http_boundary_${id}`,
        orgId: `org_http_boundary_${id}`,
        email: `fixture-${id}@http-boundary.invalid`,
      };
      ownedFixtures.push(fixture);
      ownedSlackIds.add(fixture.slackId);
      // Nonpersonal membership makes the real domain assignment return locally.
      await pool.query(
        'INSERT INTO organizations (workos_organization_id, name, is_personal) VALUES ($1, $2, false)',
        [fixture.orgId, 'Fixture HTTP Organization']
      );
      await pool.query(
        'INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email) VALUES ($1, $2, $3)',
        [fixture.userId, fixture.orgId, fixture.email]
      );
      return fixture;
    }

    function fetchedUser(fixture: { slackId: string; email: string }) {
      return {
        id: fixture.slackId, team_id: 'THTTPFIXTURE', name: 'fixture-http-user',
        is_bot: false, deleted: false,
        profile: { email: fixture.email, display_name: 'Fixture HTTP User', real_name: 'Fixture HTTP User' },
      };
    }

    beforeEach(async () => {
      vi.mocked(isSlackConfigured).mockReset().mockReturnValue(true);
      vi.mocked(getSlackUsers).mockReset().mockResolvedValue([]);
      vi.mocked(getUserChannels).mockReset().mockResolvedValue([]);
    });

    afterEach(async () => {
      for (const slackId of ownedSlackIds) {
        await pool.query('DELETE FROM slack_user_mappings WHERE slack_user_id = $1', [slackId]);
      }
      ownedSlackIds.clear();
      for (const fixture of ownedFixtures.splice(0)) {
        await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
          [fixture.userId, fixture.orgId]);
        await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [fixture.orgId]);
      }
    });

    it('should return linked count and errors array', async () => {
      const fixture = await createOwnedMember();
      vi.mocked(getSlackUsers).mockResolvedValue([fetchedUser(fixture)]);
      expect((await pool.query('SELECT 1 FROM slack_user_mappings WHERE slack_user_id = $1', [fixture.slackId])).rows).toEqual([]);
      const response = await request(app)
        .post('/api/admin/slack/auto-link-suggested')
        .expect(200);

      expect(response.body).toHaveProperty('linked');
      expect(response.body).toHaveProperty('errors');
      expect(typeof response.body.linked).toBe('number');
      expect(response.body.errors).toBeInstanceOf(Array);
      expect(response.body.linked).toBe(1);
      expect(response.body.errors).toEqual([]);
      expect(getSlackUsers).toHaveBeenCalledOnce();
      expect(getUserChannels).toHaveBeenCalledExactlyOnceWith(fixture.slackId);
      const stored = await pool.query(
        'SELECT slack_email, slack_display_name, workos_user_id, mapping_status, mapping_source, last_slack_sync_at FROM slack_user_mappings WHERE slack_user_id = $1',
        [fixture.slackId]
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({
        slack_email: fixture.email, slack_display_name: 'Fixture HTTP User', workos_user_id: fixture.userId,
        mapping_status: 'mapped', mapping_source: 'email_auto',
      });
      expect(stored.rows[0].last_slack_sync_at).not.toBeNull();
      expect((await pool.query('SELECT email FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
        [fixture.userId, fixture.orgId])).rows).toEqual([{ email: fixture.email }]);

      const repeated = await request(app).post('/api/admin/slack/auto-link-suggested').expect(200);
      expect(repeated.body.linked).toBe(0);
      expect(repeated.body.errors).toEqual([]);
      expect(getSlackUsers).toHaveBeenCalledTimes(2);
      expect(getUserChannels).toHaveBeenCalledExactlyOnceWith(fixture.slackId);
    });

    it('should retain the DB link pass when the upstream Slack list rejects', async () => {
      const existing = await createOwnedMember();
      const notFetched = await createOwnedMember();
      await new SlackDatabase().upsertSlackUser({
        slack_user_id: existing.slackId, slack_email: existing.email,
        slack_display_name: 'Existing Fixture', slack_real_name: 'Existing Fixture', slack_is_bot: false, slack_is_deleted: false,
      });
      vi.mocked(getSlackUsers).mockRejectedValue(new Error('Synthetic list unavailable'));
      const syncResult = await syncSlackUsers();
      expect(syncResult).toEqual({ total_synced: 0, new_users: 0, updated_users: 0, auto_mapped: 0,
        errors: ['Sync failed: Synthetic list unavailable'] });
      expect((await pool.query('SELECT 1 FROM slack_user_mappings WHERE slack_user_id = $1', [notFetched.slackId])).rows).toEqual([]);

      const response = await request(app).post('/api/admin/slack/auto-link-suggested').expect(200);
      expect(response.body.linked).toBe(1);
      expect(response.body.errors).toEqual([]);
      expect(getSlackUsers).toHaveBeenCalledTimes(2);
      expect(getUserChannels).toHaveBeenCalledExactlyOnceWith(existing.slackId);
      expect((await pool.query('SELECT workos_user_id, mapping_status, mapping_source FROM slack_user_mappings WHERE slack_user_id = $1',
        [existing.slackId])).rows).toEqual([{ workos_user_id: existing.userId, mapping_status: 'mapped', mapping_source: 'email_auto' }]);
      expect((await pool.query('SELECT 1 FROM slack_user_mappings WHERE slack_user_id = $1', [notFetched.slackId])).rows).toEqual([]);
      expect(response.text).not.toContain('Synthetic list unavailable');
    });

    it('should report a real link failure without changing the owned mapping', async () => {
      const fixture = await createOwnedMember();
      vi.mocked(getSlackUsers).mockResolvedValue([fetchedUser(fixture)]);
      const originalMapUser = SlackDatabase.prototype.mapUser;
      const spy = vi.spyOn(SlackDatabase.prototype, 'mapUser').mockImplementation(function (this: SlackDatabase, input) {
        if (input.slack_user_id === fixture.slackId) return Promise.reject(new Error('Synthetic map failure'));
        return originalMapUser.call(this, input);
      });
      try {
        const response = await request(app).post('/api/admin/slack/auto-link-suggested').expect(200);
        expect(response.body.linked).toBe(0);
        expect(response.body.errors).toEqual(['1 users failed to link']);
        expect(spy).toHaveBeenCalledWith({ slack_user_id: fixture.slackId, workos_user_id: fixture.userId, mapping_source: 'email_auto' });
        expect(getUserChannels).not.toHaveBeenCalled();
        expect((await pool.query('SELECT workos_user_id, mapping_status, mapping_source FROM slack_user_mappings WHERE slack_user_id = $1',
          [fixture.slackId])).rows).toEqual([{ workos_user_id: null, mapping_status: 'unmapped', mapping_source: null }]);
        expect(response.text).not.toContain('Synthetic map failure');
      } finally {
        spy.mockRestore();
      }
    });

    it('should return 0 linked when no matches exist', async () => {
      const slackId = `UHTTPNOMATCH${randomUUID().replaceAll('-', '').toUpperCase()}`;
      ownedSlackIds.add(slackId);
      // Create an unmapped Slack user with no matching AAO email
      await pool.query(
        `INSERT INTO slack_user_mappings (
          slack_user_id, slack_email, slack_display_name, slack_real_name,
          slack_is_bot, slack_is_deleted, mapping_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [slackId, 'no-match-email@nonexistent-domain.invalid', 'No Match', 'No Match User', false, false, 'unmapped']
      );

      const response = await request(app)
        .post('/api/admin/slack/auto-link-suggested')
        .expect(200);

      // Should not have linked anything since the email doesn't match any AAO user
      expect(response.body.linked).toBe(0);
      expect(response.body.errors).toEqual([]);
    });
  });

  describe('GET /api/admin/accounts/:orgId (subscription fields)', () => {
    const SUB_TEST_ORG_ID = 'org_sub_field_test';

    beforeEach(async () => {
      await pool.query(
        `INSERT INTO organizations (
           workos_organization_id, name, stripe_customer_id,
           subscription_status, stripe_subscription_id, subscription_price_lookup_key,
           subscription_product_name, subscription_amount, subscription_interval,
           subscription_currency, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET
           subscription_status = $4, stripe_subscription_id = $5,
           subscription_price_lookup_key = $6`,
        [
          SUB_TEST_ORG_ID, 'Sub Field Test Org', 'cus_sub_field_test',
          'active', 'sub_test123', 'member_annual',
          'AgenticAdvertising.org Membership', 29900, 'year', 'usd',
        ]
      );
    });

    afterEach(async () => {
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [SUB_TEST_ORG_ID]);
    });

    it('should include stripe_subscription_id and price_lookup_key in subscription object', async () => {
      const response = await request(app)
        .get(`/api/admin/accounts/${SUB_TEST_ORG_ID}`)
        .expect(200);

      expect(response.body.subscription).not.toBeNull();
      expect(response.body.subscription.stripe_subscription_id).toBe('sub_test123');
      expect(response.body.subscription.price_lookup_key).toBe('member_annual');
    });

    it('should return null (not undefined) for stripe fields when absent in DB', async () => {
      await pool.query(
        `UPDATE organizations SET stripe_subscription_id = NULL, subscription_price_lookup_key = NULL
         WHERE workos_organization_id = $1`,
        [SUB_TEST_ORG_ID]
      );
      const response = await request(app)
        .get(`/api/admin/accounts/${SUB_TEST_ORG_ID}`)
        .expect(200);

      expect(Object.prototype.hasOwnProperty.call(response.body.subscription, 'stripe_subscription_id')).toBe(true);
      expect(response.body.subscription.stripe_subscription_id).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(response.body.subscription, 'price_lookup_key')).toBe(true);
      expect(response.body.subscription.price_lookup_key).toBeNull();
    });
  });

  describe('Admin page routes (redirect regression)', () => {
    it('GET /admin/accounts should serve HTML, not redirect', async () => {
      const response = await request(app)
        .get('/admin/accounts');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/html/);
    });

    it('GET /admin/accounts/:orgId should serve HTML, not redirect', async () => {
      const response = await request(app)
        .get(`/admin/accounts/${TEST_ORG_ID}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/html/);
    });

    it('GET /admin/organizations/:orgId should redirect to /admin/accounts/:orgId', async () => {
      const response = await request(app)
        .get(`/admin/organizations/${TEST_ORG_ID}`)
        .redirects(0);

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe(`/admin/accounts/${TEST_ORG_ID}`);
    });
  });
});
