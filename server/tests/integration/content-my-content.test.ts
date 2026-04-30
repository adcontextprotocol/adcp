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

// Use importOriginal so any unmocked exports (e.g. listCustomersWithOrgIds
// called from OrganizationDatabase.syncStripeCustomers during HTTPServer.start)
// flow through to the real implementation instead of throwing.
vi.mock('../../src/billing/stripe-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/billing/stripe-client.js')>()),
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

      // Server demotes non-lead `published` requests to `pending_review`.
      // The my-content.html UI compares the requested vs returned status to
      // surface this with a toast (see #2719); keep `status` in the response
      // body so the client can detect the demotion.
      expect(response.body.status).toBe('pending_review');
    });

    it('returns 400 with field-specific message when title is too long (#2734)', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'A'.repeat(501),
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
        })
        .expect(400);

      expect(response.body.message).toMatch(/title is too long/i);
      expect(response.body.message).toContain('500');
    });

    it('accepts titles exactly at the 500-char limit', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'B'.repeat(500),
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
        })
        .expect(201);

      expect(response.body.id).toBeDefined();
    });

    it('returns 400 when subtitle exceeds the 1000-char limit', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'short title',
          subtitle: 'C'.repeat(1001),
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
        })
        .expect(400);

      expect(response.body.message).toMatch(/subtitle is too long/i);
    });

    it('rate-limits proposeContentForUser at the function level (Addie bypass) — #2733 follow-up', async () => {
      // Simulate Addie's MCP handler which calls proposeContentForUser
      // directly, bypassing HTTP middleware. Fresh user id so we start
      // with an empty window.
      const { proposeContentForUser } = await import('../../src/routes/content.js');
      const testUser = { id: 'user_mc_ratelimit_test', email: 'ratelimit@test.local' };
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name)
         VALUES ($1, $2, 'Rate', 'Limit')
         ON CONFLICT (workos_user_id) DO NOTHING`,
        [testUser.id, testUser.email]
      );

      const results: Array<{ success: boolean; error?: string }> = [];
      for (let i = 0; i < 21; i++) {
        const r = await proposeContentForUser(testUser, {
          title: `mc-test-ratelimit-${i}`,
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
        });
        results.push({ success: r.success, error: r.error });
      }

      expect(results.filter(r => r.success).length).toBe(20);
      expect(results.filter(r => !r.success && /rate limit/i.test(r.error ?? '')).length).toBe(1);

      await pool.query(
        `DELETE FROM content_authors WHERE perspective_id IN (SELECT id FROM perspectives WHERE proposer_user_id = $1)`,
        [testUser.id]
      );
      await pool.query(`DELETE FROM perspectives WHERE proposer_user_id = $1`, [testUser.id]);
      await pool.query(`DELETE FROM community_points WHERE workos_user_id = $1`, [testUser.id]);
      await pool.query(`DELETE FROM user_badges WHERE workos_user_id = $1`, [testUser.id]);
      await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [testUser.id]);
    }, 30000);

    it('exempts system: users from the function-level rate limit', async () => {
      // Newsletter pipeline + digest publisher submit as `system:addie`
      // / `system:sage`. Those automated paths must not be bounded.
      const { proposeContentForUser } = await import('../../src/routes/content.js');
      const systemUser = { id: 'system:addie', email: 'addie@agenticadvertising.org' };

      const results: Array<{ success: boolean }> = [];
      for (let i = 0; i < 25; i++) {
        const r = await proposeContentForUser(systemUser, {
          title: `mc-test-system-${i}-${Date.now()}`,
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
        });
        results.push({ success: r.success });
      }
      expect(results.every(r => r.success)).toBe(true);

      await pool.query(
        `DELETE FROM content_authors WHERE perspective_id IN (SELECT id FROM perspectives WHERE proposer_user_id = $1)`,
        [systemUser.id]
      );
      await pool.query(`DELETE FROM perspectives WHERE proposer_user_id = $1`, [systemUser.id]);
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // #2713 — rejected/archived transitions require admin or committee lead
  // ---------------------------------------------------------------------------

  describe('PUT /api/me/content/:id status transitions', () => {
    it('prevents non-admin co-author from resurrecting a rejected item', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-resurrect',
        title: 'previously rejected',
        status: 'rejected',
        proposerUserId: USER_ID,
        workingGroupId: wgId,
      });

      // Switch to a non-lead, non-admin user. Make them a co-author so
      // they pass the ownership check but NOT the lead/admin check.
      authState.userId = OTHER_USER_ID;
      authState.email = 'mc-other@example.com';
      adminState.isAdmin = false;
      await pool.query(
        `INSERT INTO content_authors (perspective_id, user_id, display_name)
         VALUES ($1, $2, 'Co-author')
         ON CONFLICT DO NOTHING`,
        [id, OTHER_USER_ID]
      );

      const response = await request(app)
        .put(`/api/me/content/${id}`)
        .send({ status: 'pending_review' })
        .expect(403);

      expect(response.body.message).toMatch(/move it out of rejected/i);
    });

    it('allows a committee lead to resurrect a rejected item in their committee', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-lead-resurrect',
        title: 'lead resurrecting',
        status: 'rejected',
        proposerUserId: USER_ID,
        workingGroupId: wgId,
      });

      // USER_ID is the lead of WG_SLUG per the test setup at line 130
      authState.userId = USER_ID;
      authState.email = 'mc@example.com';
      adminState.isAdmin = false;

      const response = await request(app)
        .put(`/api/me/content/${id}`)
        .send({ status: 'pending_review' })
        .expect(200);

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
  // #2569 — proposer relationship in GET /api/me/content (edit-button fix)
  //
  // After saving, a user's relationship can resolve to only `proposer` (no
  // content_authors row). The canEdit check in admin-content.html must see
  // `relationships.includes('proposer')` or the Edit button disappears.
  // ---------------------------------------------------------------------------

  describe('GET /api/me/content — proposer relationship (#2569)', () => {
    it('includes "proposer" in relationships when user is only the proposer (no content_authors row)', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-proposer-rel',
        title: 'Proposer only',
        proposerUserId: USER_ID,
      });

      const response = await request(app).get('/api/me/content').expect(200);
      const item = response.body.items.find((i: any) => i.id === id);
      expect(item).toBeDefined();
      // Positive exhaustive assertion: a proposer-only user has exactly ['proposer']
      expect(item.relationships).toEqual(['proposer']);
    });
  });

  // ---------------------------------------------------------------------------
  // #2569 — co-author add/remove via POST/DELETE /api/me/content/:id/authors
  //
  // Original bug: the form POSTed { display_name } only; the endpoint requires
  // both user_id and display_name and returned 400. Fixed in PR #2241.
  // ---------------------------------------------------------------------------

  describe('POST /api/me/content/:id/authors (#2569)', () => {
    it('adds a co-author and persists the DB row when user_id + display_name provided', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-add',
        title: 'Co-author add',
        proposerUserId: USER_ID,
      });

      const response = await request(app)
        .post(`/api/me/content/${id}/authors`)
        .send({ user_id: OTHER_USER_ID, display_name: 'Other User' })
        .expect(201);

      expect(response.body.user_id).toBe(OTHER_USER_ID);
      expect(response.body.display_name).toBe('Other User');

      const db = await pool.query(
        `SELECT user_id, display_name FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
        [id, OTHER_USER_ID]
      );
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0].display_name).toBe('Other User');
    });

    it('returns 400 with a message naming user_id when user_id is missing (regression for original bug)', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-no-userid',
        title: 'Co-author missing user_id',
        proposerUserId: USER_ID,
      });

      const response = await request(app)
        .post(`/api/me/content/${id}/authors`)
        .send({ display_name: 'Name Only' })
        .expect(400);

      expect(response.body.message).toMatch(/user_id/i);
    });

    it('returns 400 when display_name is missing', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-no-displayname',
        title: 'Co-author missing display_name',
        proposerUserId: USER_ID,
      });

      const response = await request(app)
        .post(`/api/me/content/${id}/authors`)
        .send({ user_id: OTHER_USER_ID })
        .expect(400);

      expect(response.body.message).toMatch(/display_name/i);
    });

    it('returns 403 when the requester is neither proposer nor lead nor admin', async () => {
      // OTHER_USER_ID owns this perspective; USER_ID is unrelated (not proposer, not lead, not admin)
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-forbidden',
        title: 'Co-author forbidden',
        proposerUserId: OTHER_USER_ID,
      });

      // authState defaults to USER_ID from beforeEach — confirmed neither proposer nor lead
      adminState.isAdmin = false;
      await request(app)
        .post(`/api/me/content/${id}/authors`)
        .send({ user_id: USER_ID, display_name: 'Mary Content' })
        .expect(403);
    });

    it('upserts cleanly: adding the same user_id twice results in one row with the latest display_name', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-upsert',
        title: 'Co-author upsert',
        proposerUserId: USER_ID,
      });

      await request(app)
        .post(`/api/me/content/${id}/authors`)
        .send({ user_id: OTHER_USER_ID, display_name: 'First Name' })
        .expect(201);

      await request(app)
        .post(`/api/me/content/${id}/authors`)
        .send({ user_id: OTHER_USER_ID, display_name: 'Updated Name' })
        .expect(201);

      const db = await pool.query(
        `SELECT display_name, display_order FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
        [id, OTHER_USER_ID]
      );
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0].display_name).toBe('Updated Name');
      // display_order is set on insert only — upsert must not reset it to the incremented value
      expect(db.rows[0].display_order).toBe(0);
    });

    it('returns 400 when user_id is not a known account (prevents FK 500)', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-unknown-user',
        title: 'Co-author unknown user',
        proposerUserId: USER_ID,
      });

      const response = await request(app)
        .post(`/api/me/content/${id}/authors`)
        .send({ user_id: 'nonexistent-workos-user-xyz', display_name: 'Ghost' })
        .expect(400);

      expect(response.body.error).toBe('User not found');
      expect(response.body.message).toMatch(/No account found/i);
    });
  });

  describe('DELETE /api/me/content/:id/authors/:authorId (#2569)', () => {
    it('removes the co-author row and returns deleted user_id when called by the proposer', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-remove',
        title: 'Co-author remove',
        proposerUserId: USER_ID,
      });

      // Seed a co-author row directly so we can test deletion independently of POST
      await pool.query(
        `INSERT INTO content_authors (perspective_id, user_id, display_name, display_order)
         VALUES ($1, $2, 'To Remove', 0)`,
        [id, OTHER_USER_ID]
      );

      const response = await request(app)
        .delete(`/api/me/content/${id}/authors/${OTHER_USER_ID}`)
        .expect(200);

      expect(response.body.deleted).toBe(OTHER_USER_ID);

      const db = await pool.query(
        `SELECT user_id FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
        [id, OTHER_USER_ID]
      );
      expect(db.rows).toHaveLength(0);
    });

    it('returns 403 when a co-author (not the proposer) tries to remove someone', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-delete-forbidden',
        title: 'Co-author delete forbidden',
        proposerUserId: OTHER_USER_ID, // OTHER_USER is proposer
      });

      // USER_ID is just a co-author, not the proposer
      await pool.query(
        `INSERT INTO content_authors (perspective_id, user_id, display_name, display_order)
         VALUES ($1, $2, 'Mary Content', 0)`,
        [id, USER_ID]
      );

      // authState is USER_ID per beforeEach; USER_ID is NOT proposer/lead/admin here
      adminState.isAdmin = false;
      await request(app)
        .delete(`/api/me/content/${id}/authors/${OTHER_USER_ID}`)
        .expect(403);
    });

    it('returns 404 when the authorId does not exist on the content', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-coauthor-delete-missing',
        title: 'Co-author delete missing',
        proposerUserId: USER_ID,
      });

      await request(app)
        .delete(`/api/me/content/${id}/authors/nonexistent-user-id`)
        .expect(404);
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
