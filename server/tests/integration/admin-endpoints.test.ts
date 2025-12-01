import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Mock auth middleware to bypass authentication in tests
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.user = {
      workos_user_id: 'user_test_admin',
      email: 'admin@test.com',
      is_admin: true
    };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => next(),
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

  describe('GET /api/admin/members', () => {
    it('should list all organization members', async () => {
      const response = await request(app)
        .get('/api/admin/members')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);

      // Should include our test organization
      const testOrg = response.body.find((m: any) => m.company_id === TEST_ORG_ID);
      expect(testOrg).toBeDefined();
      expect(testOrg.company_name).toBe('Test Admin Org');
      expect(testOrg.subscription_status).toMatch(/none|active|expired|canceled/);
    });

    it('should compute subscription status correctly', async () => {
      // Set up organization with active subscription
      await pool.query(
        `UPDATE organizations
         SET subscription_amount = 2999,
             subscription_interval = 'month',
             subscription_current_period_end = NOW() + INTERVAL '30 days',
             subscription_canceled_at = NULL
         WHERE workos_organization_id = $1`,
        [TEST_ORG_ID]
      );

      const response = await request(app)
        .get('/api/admin/members')
        .expect(200);

      const testOrg = response.body.find((m: any) => m.company_id === TEST_ORG_ID);
      expect(testOrg.subscription_status).toBe('active');
    });

    it('should show canceled status when subscription is canceled', async () => {
      // Set up organization with canceled subscription
      await pool.query(
        `UPDATE organizations
         SET subscription_amount = 2999,
             subscription_interval = 'month',
             subscription_current_period_end = NOW() + INTERVAL '30 days',
             subscription_canceled_at = NOW()
         WHERE workos_organization_id = $1`,
        [TEST_ORG_ID]
      );

      const response = await request(app)
        .get('/api/admin/members')
        .expect(200);

      const testOrg = response.body.find((m: any) => m.company_id === TEST_ORG_ID);
      expect(testOrg.subscription_status).toBe('canceled');
    });
  });

  describe('GET /api/admin/agreements', () => {
    it('should list all agreements', async () => {
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
      expect(response.body[0]).toHaveProperty('text');
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

  describe('POST /api/admin/members/:orgId/sync', () => {
    it('should sync organization data from WorkOS and Stripe', async () => {
      // First check that organization exists and has subscription data
      const beforeSync = await pool.query(
        'SELECT subscription_amount, subscription_current_period_end FROM organizations WHERE workos_organization_id = $1',
        [TEST_ORG_ID]
      );

      // Call the sync endpoint
      const response = await request(app)
        .post(`/api/admin/members/${TEST_ORG_ID}/sync`)
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
        .post('/api/admin/members/org_nonexistent/sync')
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
        .post(`/api/admin/members/${fakeOrgId}/sync`)
        .expect(200);

      // WorkOS should fail for non-existent org
      expect(response.body.workos.success).toBe(false);
      expect(response.body.workos.error).toBeDefined();

      // Clean up
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [fakeOrgId]);
    });
  });
});
