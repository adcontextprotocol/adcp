import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

// Mock auth middleware to bypass authentication
vi.mock('../../src/middleware/auth.js', () => {
  const setTestUser = (req: any) => {
    req.user = {
      id: 'user_test_assets',
      email: 'test-assets@example.com',
      is_admin: true,
      firstName: 'Test',
    };
  };
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    requireAuth: (req: any, _res: any, next: any) => { setTestUser(req); next(); },
    requireAdmin: passthrough,
    optionalAuth: (req: any, _res: any, next: any) => { setTestUser(req); next(); },
    requireCompanyAccess: passthrough,
    requireActiveSubscription: passthrough,
    requireSignedAgreement: passthrough,
    requireRole: () => passthrough,
    createRequireWorkingGroupLeader: () => passthrough,
    createRequireWorkingGroupMember: () => passthrough,
    invalidateSessionCache: vi.fn(),
    invalidateBanCache: vi.fn(),
    isDevModeEnabled: () => false,
    getDevUser: () => null,
    getAvailableDevUsers: () => ({}),
    getDevSessionCookieName: () => 'dev_session',
    DEV_USERS: {},
  };
});

// Mock MCP routes to avoid URL validation issues in test env
vi.mock('../../src/mcp/routes.js', () => ({
  configureMCPRoutes: vi.fn(),
}));

// Disable CSRF protection in tests
vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

// Mock admin check so test user is treated as admin
vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isWebUserAAOAdmin: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

// Create a 1x1 red PNG for testing (68 bytes)
function createTestPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  );
}

// Create a minimal PDF for testing
function createTestPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
    'xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n' +
    'trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n109\n%%EOF'
  );
}

describe('Perspective Assets Integration Tests', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  let testPerspectiveId: string;
  let testWgId: string;
  const TEST_SLUG = 'test-asset-perspective';

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    // Use the editorial working group (the serving route filters to editorial WG)
    const wgResult = await pool.query(
      `INSERT INTO working_groups (name, slug, description, accepts_public_submissions)
       VALUES ('Editorial', 'editorial', 'Editorial WG', true)
       ON CONFLICT (slug) DO UPDATE SET accepts_public_submissions = true
       RETURNING id`
    );
    testWgId = wgResult.rows[0].id;

    // Create test perspective
    const perspResult = await pool.query(
      `INSERT INTO perspectives (slug, content_type, title, content, category, status, published_at, working_group_id, content_origin, author_user_id, proposer_user_id)
       VALUES ($1, 'article', 'Test Asset Perspective', 'Test content body.', 'Perspective', 'published', NOW(), $2, 'member', 'user_test_assets', 'user_test_assets')
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
      [TEST_SLUG, testWgId]
    );
    testPerspectiveId = perspResult.rows[0].id;

    // Create user record for author checks
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name)
       VALUES ('user_test_assets', 'test-assets@example.com', 'Test', 'Assets')
       ON CONFLICT (workos_user_id) DO NOTHING`
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM perspective_assets WHERE perspective_id = $1`, [testPerspectiveId]);
    await pool.query(`DELETE FROM content_authors WHERE perspective_id = $1`, [testPerspectiveId]);
    await pool.query(`DELETE FROM perspectives WHERE slug = $1`, [TEST_SLUG]);
    await pool.query(`DELETE FROM perspectives WHERE slug LIKE 'test-propose-%'`);
    await pool.query(`DELETE FROM working_groups WHERE slug = 'editorial'`);
    await server?.stop();
    await closeDatabase();
  });

  // =========================================================================
  // Asset Upload (POST /api/content/:slug/assets)
  // =========================================================================

  describe('POST /api/content/:slug/assets', () => {
    it('should upload a cover image', async () => {
      const png = createTestPng();
      const response = await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', png, { filename: 'cover.png', contentType: 'image/png' })
        .field('asset_type', 'cover_image')
        .expect(201);

      expect(response.body.asset).toBeDefined();
      expect(response.body.asset.asset_type).toBe('cover_image');
      expect(response.body.asset.file_mime_type).toBe('image/png');
      expect(response.body.asset.file_name).toBe('cover.png');
      expect(response.body.asset.url).toContain(`/api/perspectives/${TEST_SLUG}/assets/cover.png`);
    });

    it('should auto-update featured_image_url on cover image upload', async () => {
      const result = await pool.query(
        `SELECT featured_image_url FROM perspectives WHERE slug = $1`,
        [TEST_SLUG]
      );
      expect(result.rows[0].featured_image_url).toContain(`/api/perspectives/${TEST_SLUG}/assets/cover.png`);
    });

    it('should upload a PDF report', async () => {
      const pdf = createTestPdf();
      const response = await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', pdf, { filename: 'report.pdf', contentType: 'application/pdf' })
        .field('asset_type', 'report')
        .expect(201);

      expect(response.body.asset.asset_type).toBe('report');
      expect(response.body.asset.file_mime_type).toBe('application/pdf');
    });

    it('should replace existing cover image on re-upload', async () => {
      const png = createTestPng();
      const response = await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', png, { filename: 'new-cover.png', contentType: 'image/png' })
        .field('asset_type', 'cover_image')
        .expect(201);

      expect(response.body.asset.file_name).toBe('new-cover.png');

      // Only one cover image should exist
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM perspective_assets WHERE perspective_id = $1 AND asset_type = 'cover_image'`,
        [testPerspectiveId]
      );
      expect(parseInt(result.rows[0].count)).toBe(1);
    });

    it('should reject missing file', async () => {
      await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .field('asset_type', 'cover_image')
        .expect(400);
    });

    it('should reject invalid asset_type', async () => {
      const png = createTestPng();
      const response = await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', png, { filename: 'test.png', contentType: 'image/png' })
        .field('asset_type', 'invalid_type')
        .expect(400);

      expect(response.body.error).toContain('asset_type');
    });

    it('should reject upload for nonexistent perspective', async () => {
      const png = createTestPng();
      await request(app)
        .post(`/api/content/nonexistent-slug-12345/assets`)
        .attach('file', png, { filename: 'test.png', contentType: 'image/png' })
        .field('asset_type', 'cover_image')
        .expect(404);
    });

    it('should reject disallowed MIME types', async () => {
      const html = Buffer.from('<html><body>XSS</body></html>');
      await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', html, { filename: 'malicious.html', contentType: 'text/html' })
        .field('asset_type', 'attachment')
        .expect(400);
    });

    it('should sanitize filenames', async () => {
      const png = createTestPng();
      const response = await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', png, { filename: 'my file <script>.png', contentType: 'image/png' })
        .field('asset_type', 'attachment')
        .expect(201);

      // Should not contain angle brackets
      expect(response.body.asset.file_name).not.toContain('<');
      expect(response.body.asset.file_name).not.toContain('>');
    });
  });

  // =========================================================================
  // Asset Serving (GET /api/perspectives/:slug/assets/:filename)
  // =========================================================================

  describe('GET /api/perspectives/:slug/assets/:filename', () => {
    it('should serve an uploaded image with correct headers', async () => {
      const response = await request(app)
        .get(`/api/perspectives/${TEST_SLUG}/assets/new-cover.png`)
        .expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe("default-src 'none'");
      expect(response.headers['cache-control']).toBe('public, max-age=86400');
      expect(response.body).toBeInstanceOf(Buffer);
    });

    it('should serve PDF with correct content type', async () => {
      const response = await request(app)
        .get(`/api/perspectives/${TEST_SLUG}/assets/report.pdf`)
        .expect(200);

      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain('report.pdf');
    });

    it('should return 404 for nonexistent asset', async () => {
      await request(app)
        .get(`/api/perspectives/${TEST_SLUG}/assets/does-not-exist.png`)
        .expect(404);
    });

    it('should return 404 for nonexistent perspective slug', async () => {
      await request(app)
        .get('/api/perspectives/no-such-perspective/assets/cover.png')
        .expect(404);
    });

    it('should return 404 for unpublished perspective', async () => {
      // Create a draft perspective
      await pool.query(
        `INSERT INTO perspectives (slug, content_type, title, content, status, working_group_id, content_origin)
         VALUES ('test-draft-perspective', 'article', 'Draft', 'Draft body', 'draft', $1, 'member')
         ON CONFLICT (slug) DO UPDATE SET status = 'draft'
         RETURNING id`,
        [testWgId]
      );

      await request(app)
        .get('/api/perspectives/test-draft-perspective/assets/cover.png')
        .expect(404);

      await pool.query(`DELETE FROM perspectives WHERE slug = 'test-draft-perspective'`);
    });
  });

  // =========================================================================
  // Admin Content API
  // =========================================================================

  describe('GET /api/admin/content', () => {
    it('should list all perspectives with content_origin', async () => {
      const response = await request(app)
        .get('/api/admin/content')
        .expect(200);

      expect(response.body.items).toBeInstanceOf(Array);
      const testItem = response.body.items.find((i: any) => i.slug === TEST_SLUG);
      expect(testItem).toBeDefined();
      expect(testItem.content_origin).toBe('member');
      expect(testItem.title).toBe('Test Asset Perspective');
    });
  });

  describe('PUT /api/admin/content/:id/origin', () => {
    it('should update content_origin to official', async () => {
      await request(app)
        .put(`/api/admin/content/${testPerspectiveId}/origin`)
        .send({ content_origin: 'official' })
        .expect(200);

      const result = await pool.query(
        `SELECT content_origin FROM perspectives WHERE id = $1`,
        [testPerspectiveId]
      );
      expect(result.rows[0].content_origin).toBe('official');
    });

    it('should update content_origin to external', async () => {
      await request(app)
        .put(`/api/admin/content/${testPerspectiveId}/origin`)
        .send({ content_origin: 'external' })
        .expect(200);

      const result = await pool.query(
        `SELECT content_origin FROM perspectives WHERE id = $1`,
        [testPerspectiveId]
      );
      expect(result.rows[0].content_origin).toBe('external');
    });

    it('should reject invalid content_origin values', async () => {
      await request(app)
        .put(`/api/admin/content/${testPerspectiveId}/origin`)
        .send({ content_origin: 'invalid' })
        .expect(400);
    });

    it('should reject missing content_origin', async () => {
      await request(app)
        .put(`/api/admin/content/${testPerspectiveId}/origin`)
        .send({})
        .expect(400);
    });

    // Reset to member for subsequent tests
    afterAll(async () => {
      await pool.query(
        `UPDATE perspectives SET content_origin = 'member' WHERE id = $1`,
        [testPerspectiveId]
      );
    });
  });

  // =========================================================================
  // Content Proposal with new fields
  // =========================================================================

  describe('POST /api/content/propose', () => {
    it('should accept subtitle, author_title, and featured_image_url', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'Test Propose Full Fields',
          subtitle: 'A subtitle for testing',
          content: 'Article content body here.',
          content_type: 'article',
          category: 'Perspective',
          author_title: 'CEO, Test Corp',
          featured_image_url: 'https://example.com/image.jpg',
          content_origin: 'official',
          collection: { slug: 'editorial' },
        })
        .expect(201);

      expect(response.body.slug).toBeDefined();
      expect(response.body.status).toBe('published'); // admin auto-publishes

      const result = await pool.query(
        `SELECT subtitle, author_title, featured_image_url, content_origin FROM perspectives WHERE slug = $1`,
        [response.body.slug]
      );
      expect(result.rows[0].subtitle).toBe('A subtitle for testing');
      expect(result.rows[0].author_title).toBe('CEO, Test Corp');
      expect(result.rows[0].featured_image_url).toBe('https://example.com/image.jpg');
      expect(result.rows[0].content_origin).toBe('official');
    });

    it('should default content_origin to member', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'Test Propose Default Origin',
          content: 'Content here.',
          content_type: 'article',
          collection: { slug: 'editorial' },
        })
        .expect(201);

      const result = await pool.query(
        `SELECT content_origin FROM perspectives WHERE slug = $1`,
        [response.body.slug]
      );
      expect(result.rows[0].content_origin).toBe('member');
    });
  });

  // =========================================================================
  // Perspectives API with content_origin filter
  // =========================================================================

  describe('GET /api/perspectives', () => {
    beforeAll(async () => {
      // Ensure we have one official and one member perspective
      await pool.query(
        `UPDATE perspectives SET content_origin = 'official' WHERE slug = $1`,
        [TEST_SLUG]
      );
    });

    it('should include content_origin in response', async () => {
      const response = await request(app)
        .get('/api/perspectives?authored=true')
        .expect(200);

      const items = response.body.items || response.body;
      if (Array.isArray(items) && items.length > 0) {
        const testItem = items.find((i: any) => i.slug === TEST_SLUG);
        if (testItem) {
          expect(testItem.content_origin).toBe('official');
        }
      }
    });

    afterAll(async () => {
      await pool.query(
        `UPDATE perspectives SET content_origin = 'member' WHERE slug = $1`,
        [TEST_SLUG]
      );
    });
  });

  // =========================================================================
  // Multiple assets per perspective
  // =========================================================================

  describe('Multiple assets per perspective', () => {
    it('should support multiple non-cover assets with different filenames', async () => {
      const png = createTestPng();

      await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', png, { filename: 'chart1.png', contentType: 'image/png' })
        .field('asset_type', 'attachment')
        .expect(201);

      await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', png, { filename: 'chart2.png', contentType: 'image/png' })
        .field('asset_type', 'attachment')
        .expect(201);

      // Both should be servable
      await request(app)
        .get(`/api/perspectives/${TEST_SLUG}/assets/chart1.png`)
        .expect(200);
      await request(app)
        .get(`/api/perspectives/${TEST_SLUG}/assets/chart2.png`)
        .expect(200);
    });

    it('should upsert when uploading same filename again', async () => {
      const png = createTestPng();

      await request(app)
        .post(`/api/content/${TEST_SLUG}/assets`)
        .attach('file', png, { filename: 'chart1.png', contentType: 'image/png' })
        .field('asset_type', 'attachment')
        .expect(201);

      // Should still have exactly one asset with this filename
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM perspective_assets WHERE perspective_id = $1 AND file_name = 'chart1.png'`,
        [testPerspectiveId]
      );
      expect(parseInt(result.rows[0].count)).toBe(1);
    });
  });

  // =========================================================================
  // Database functions directly
  // =========================================================================

  describe('perspective-asset-db functions', () => {
    it('getAssetsByPerspective returns metadata without binary', async () => {
      const { getAssetsByPerspective } = await import('../../src/db/perspective-asset-db.js');
      const assets = await getAssetsByPerspective(testPerspectiveId);

      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        expect(asset.id).toBeDefined();
        expect(asset.perspective_id).toBe(testPerspectiveId);
        expect(asset.file_name).toBeDefined();
        expect(asset.file_mime_type).toBeDefined();
        expect(asset.file_size_bytes).toBeGreaterThan(0);
        // Should NOT include file_data
        expect((asset as any).file_data).toBeUndefined();
      }
    });

    it('getAssetData returns binary data', async () => {
      const { getAssetData } = await import('../../src/db/perspective-asset-db.js');
      const asset = await getAssetData(testPerspectiveId, 'report.pdf');

      expect(asset).not.toBeNull();
      expect(asset!.file_data).toBeInstanceOf(Buffer);
      expect(asset!.file_mime_type).toBe('application/pdf');
    });

    it('getAssetData returns null for missing asset', async () => {
      const { getAssetData } = await import('../../src/db/perspective-asset-db.js');
      const asset = await getAssetData(testPerspectiveId, 'nonexistent.png');
      expect(asset).toBeNull();
    });

    it('getAssetByType finds cover image', async () => {
      const { getAssetByType } = await import('../../src/db/perspective-asset-db.js');
      const asset = await getAssetByType(testPerspectiveId, 'cover_image');
      expect(asset).not.toBeNull();
      expect(asset!.asset_type).toBe('cover_image');
    });

    it('deleteAsset removes an asset', async () => {
      const { getAssetsByPerspective, deleteAsset } = await import('../../src/db/perspective-asset-db.js');
      const assets = await getAssetsByPerspective(testPerspectiveId);
      const attachments = assets.filter(a => a.asset_type === 'attachment');

      if (attachments.length > 0) {
        const deleted = await deleteAsset(attachments[0].id);
        expect(deleted).toBe(true);

        // Should not exist anymore
        const deletedAgain = await deleteAsset(attachments[0].id);
        expect(deletedAgain).toBe(false);
      }
    });
  });
});
