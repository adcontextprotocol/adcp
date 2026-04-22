import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock WorkOS client before any imports that depend on it
vi.mock('../../src/auth/workos-client.js', () => ({
  workos: {
    userManagement: {
      getUser: vi.fn().mockResolvedValue({ id: 'user_my_content', email: 'mc@example.com', firstName: 'Mary', lastName: 'Content' }),
      listUsers: vi.fn().mockResolvedValue({ data: [], listMetadata: {} }),
    },
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ id: 'org_test', name: 'Test Org' }),
    },
  },
}));

// Dynamic admin flag so each test can flip the current user between admin and
// non-admin. The mock reads this at call time.
const authState = {
  userId: 'user_my_content',
  email: 'mc@example.com',
};

vi.mock('../../src/middleware/auth.js', () => {
  const setTestUser = (req: any) => {
    req.user = {
      id: authState.userId,
      email: authState.email,
      firstName: 'Mary',
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

vi.mock('../../src/mcp/routes.js', () => ({
  configureMCPRoutes: vi.fn(),
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

const adminState = { isAdmin: false };
vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isWebUserAAOAdmin: vi.fn(async () => adminState.isAdmin),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

// Swallow the Slack side-effects that would otherwise noisy-fail the test.
vi.mock('../../src/notifications/slack.js', () => ({
  notifyPublishedPost: vi.fn().mockResolvedValue(undefined),
  notifyMeetingStarted: vi.fn().mockResolvedValue(false),
  sendSocialAmplificationDM: vi.fn().mockResolvedValue(undefined),
  sendChannelMessage: vi.fn().mockResolvedValue(undefined),
}));

import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

describe('My Content — body, admin scope, status, delete', () => {
  let server: HTTPServer;
  let app: any;
  let pool: Pool;
  let wgId: string;
  const WG_SLUG = 'mc-test-wg';
  const USER_ID = 'user_my_content';
  const OTHER_USER_ID = 'user_my_content_other';

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    // Ensure users exist
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name)
       VALUES ($1, 'mc@example.com', 'Mary', 'Content')
       ON CONFLICT (workos_user_id) DO NOTHING`,
      [USER_ID]
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name)
       VALUES ($1, 'mc-other@example.com', 'Other', 'User')
       ON CONFLICT (workos_user_id) DO NOTHING`,
      [OTHER_USER_ID]
    );

    const wgResult = await pool.query(
      `INSERT INTO working_groups (name, slug, description, accepts_public_submissions)
       VALUES ('MC Test WG', $1, 'test wg', true)
       ON CONFLICT (slug) DO UPDATE SET accepts_public_submissions = true
       RETURNING id`,
      [WG_SLUG]
    );
    wgId = wgResult.rows[0].id;

    // Make the test user a lead of this working group so canPublishDirectly is true.
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [wgId, USER_ID]
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM content_authors WHERE perspective_id IN (SELECT id FROM perspectives WHERE slug LIKE 'mc-test-%')`);
    await pool.query(`DELETE FROM perspectives WHERE slug LIKE 'mc-test-%'`);
    await pool.query(`DELETE FROM working_group_leaders WHERE working_group_id = $1`, [wgId]);
    await pool.query(`DELETE FROM working_groups WHERE slug = $1`, [WG_SLUG]);
    // Side tables the propose flow writes into. Clear everything referencing
    // the test users before deleting them so FKs don't block cleanup.
    const testUsers = [USER_ID, OTHER_USER_ID];
    await pool.query(`DELETE FROM community_points WHERE workos_user_id = ANY($1)`, [testUsers]);
    await pool.query(`DELETE FROM user_badges WHERE workos_user_id = ANY($1)`, [testUsers]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = ANY($1)`, [testUsers]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    adminState.isAdmin = false;
    authState.userId = USER_ID;
    authState.email = 'mc@example.com';
    await pool.query(`DELETE FROM content_authors WHERE perspective_id IN (SELECT id FROM perspectives WHERE slug LIKE 'mc-test-%')`);
    await pool.query(`DELETE FROM perspectives WHERE slug LIKE 'mc-test-%'`);
  });

  async function insertPerspective(opts: {
    slug: string;
    title: string;
    content?: string;
    status?: string;
    proposerUserId?: string | null;
    workingGroupId?: string | null;
  }) {
    const { slug, title } = opts;
    const status = opts.status ?? 'published';
    const result = await pool.query(
      `INSERT INTO perspectives
         (slug, content_type, title, content, excerpt, category, status, published_at,
          working_group_id, content_origin, proposer_user_id, author_name)
       VALUES ($1, 'article', $2, $3, 'summary', 'Perspective', $4::varchar,
               CASE WHEN $4::varchar = 'published' THEN NOW() ELSE NULL END,
               $5, 'member', $6, 'Author')
       RETURNING id`,
      [
        slug, title,
        opts.content ?? `Body of ${title}`,
        status,
        opts.workingGroupId ?? null,
        opts.proposerUserId ?? null,
      ]
    );
    return result.rows[0].id as string;
  }

  // ---------------------------------------------------------------------------
  // #2291 — body and admin scope for GET /api/me/content
  // ---------------------------------------------------------------------------

  describe('GET /api/me/content', () => {
    it('returns the article body so the edit modal can populate it', async () => {
      await insertPerspective({
        slug: 'mc-test-own',
        title: 'Mine',
        content: 'FULL BODY MARKDOWN',
        proposerUserId: USER_ID,
      });

      const response = await request(app).get('/api/me/content').expect(200);
      const mine = response.body.items.find((i: any) => i.slug === 'mc-test-own');
      expect(mine).toBeDefined();
      expect(mine.content).toBe('FULL BODY MARKDOWN');
    });

    it('non-admins do not see content they are unrelated to', async () => {
      await insertPerspective({
        slug: 'mc-test-orphan',
        title: 'Orphaned official content',
        proposerUserId: null,
        workingGroupId: null,
      });

      const response = await request(app).get('/api/me/content').expect(200);
      const slugs = response.body.items.map((i: any) => i.slug);
      expect(slugs).not.toContain('mc-test-orphan');
    });

    it('admins see every perspective so they can edit anything', async () => {
      await insertPerspective({
        slug: 'mc-test-orphan',
        title: 'Orphaned official content',
        proposerUserId: null,
        workingGroupId: null,
      });

      adminState.isAdmin = true;
      const response = await request(app).get('/api/me/content').expect(200);
      const slugs = response.body.items.map((i: any) => i.slug);
      expect(slugs).toContain('mc-test-orphan');
    });
  });

  // ---------------------------------------------------------------------------
  // #2292 — lead/admin drafts must not auto-publish when review is requested
  // ---------------------------------------------------------------------------

  describe('POST /api/content/propose', () => {
    it('respects pending_review requested by a committee lead', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-review-draft',
          content: 'draft body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
          status: 'pending_review',
        })
        .expect(201);

      expect(response.body.status).toBe('pending_review');

      const db = await pool.query(
        `SELECT status, published_at FROM perspectives WHERE id = $1`,
        [response.body.id]
      );
      expect(db.rows[0].status).toBe('pending_review');
      expect(db.rows[0].published_at).toBeNull();
    });

    it('respects draft requested by a committee lead', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-lead-draft',
          content: 'draft body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
          status: 'draft',
        })
        .expect(201);

      expect(response.body.status).toBe('draft');
    });

    it('defaults leads to pending_review when no status is requested (no silent auto-publish)', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-lead-default',
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
        })
        .expect(201);

      expect(response.body.status).toBe('pending_review');

      const db = await pool.query(
        `SELECT status, published_at FROM perspectives WHERE id = $1`,
        [response.body.id]
      );
      expect(db.rows[0].status).toBe('pending_review');
      expect(db.rows[0].published_at).toBeNull();
    });

    it('leads who pass status=published explicitly are honored', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-lead-publish',
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
          status: 'published',
        })
        .expect(201);

      expect(response.body.status).toBe('published');
    });

    it('non-leads cannot self-publish by sending status=published', async () => {
      // Switch to a non-lead user (not in working_group_leaders, not admin)
      authState.userId = OTHER_USER_ID;
      authState.email = 'mc-other@example.com';

      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-escalate',
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
          status: 'published',
        })
        .expect(201);

      expect(response.body.status).toBe('pending_review');
    });
  });

  // ---------------------------------------------------------------------------
  // #2292 follow-on — users can delete their own non-published content
  // ---------------------------------------------------------------------------

  describe('DELETE /api/me/content/:id', () => {
    it('lets the proposer delete their own draft', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-delete-mine',
        title: 'to delete',
        status: 'draft',
        proposerUserId: USER_ID,
      });

      await request(app).delete(`/api/me/content/${id}`).expect(200);

      const db = await pool.query(`SELECT id FROM perspectives WHERE id = $1`, [id]);
      expect(db.rows).toHaveLength(0);
    });

    it('blocks non-admins from deleting published content', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-delete-published',
        title: 'published mine',
        status: 'published',
        proposerUserId: USER_ID,
      });

      const response = await request(app).delete(`/api/me/content/${id}`).expect(403);
      expect(response.body.message).toMatch(/admin/i);

      const db = await pool.query(`SELECT status FROM perspectives WHERE id = $1`, [id]);
      expect(db.rows).toHaveLength(1);
    });

    it('admins can delete anything, including published', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-admin-delete',
        title: 'admin deletes this',
        status: 'published',
        proposerUserId: OTHER_USER_ID,
      });

      adminState.isAdmin = true;
      await request(app).delete(`/api/me/content/${id}`).expect(200);

      const db = await pool.query(`SELECT id FROM perspectives WHERE id = $1`, [id]);
      expect(db.rows).toHaveLength(0);
    });

    it('returns 403 when a stranger tries to delete someone else', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-not-mine',
        title: 'not mine',
        status: 'draft',
        proposerUserId: OTHER_USER_ID,
      });

      await request(app).delete(`/api/me/content/${id}`).expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // #2539 — review modal needs enough fields to actually review a submission
  // ---------------------------------------------------------------------------

  describe('GET /api/content/pending', () => {
    async function insertLinkPerspective(opts: {
      slug: string;
      title: string;
      subtitle?: string;
      externalUrl: string;
      externalSiteName?: string;
      workingGroupId?: string | null;
    }) {
      const result = await pool.query(
        `INSERT INTO perspectives
           (slug, content_type, title, subtitle, content, excerpt, category,
            status, external_url, external_site_name, working_group_id,
            content_origin, proposer_user_id, author_name, proposed_at)
         VALUES ($1, 'link', $2, $3, NULL, 'link excerpt', 'Perspective',
                 'pending_review', $4, $5, $6, 'member', $7, 'Author', NOW())
         RETURNING id`,
        [
          opts.slug,
          opts.title,
          opts.subtitle ?? null,
          opts.externalUrl,
          opts.externalSiteName ?? null,
          opts.workingGroupId ?? wgId,
          USER_ID,
        ]
      );
      return result.rows[0].id as string;
    }

    it('surfaces external_url and subtitle so reviewers can evaluate link submissions', async () => {
      await insertLinkPerspective({
        slug: 'mc-test-pending-link',
        title: 'An external read',
        subtitle: 'Why agents matter',
        externalUrl: 'https://example.com/article',
        externalSiteName: 'Example Blog',
      });

      const response = await request(app).get('/api/content/pending').expect(200);
      const item = response.body.items.find((i: any) => i.slug === 'mc-test-pending-link');
      expect(item).toBeDefined();
      expect(item.external_url).toBe('https://example.com/article');
      expect(item.external_site_name).toBe('Example Blog');
      expect(item.subtitle).toBe('Why agents matter');
      expect(item.content_type).toBe('link');
    });
  });
});
