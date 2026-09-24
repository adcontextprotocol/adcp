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
  authWorkosUserId: undefined as string | undefined,
  email: 'mc@example.com',
  requestUser: undefined as Record<string, unknown> | undefined,
};

vi.mock('../../src/middleware/auth.js', () => {
  const setTestUser = (req: any) => {
    req.user = {
      id: authState.userId,
      authWorkosUserId: authState.authWorkosUserId,
      email: authState.email,
      firstName: 'Mary',
    };
    authState.requestUser = req.user;
  };
  const passthrough = (_req: any, _res: any, next: any) => next();
  const requireAuthMock = (req: any, _res: any, next: any) => { setTestUser(req); next(); };
  return {
    requireAuth: requireAuthMock,
    requireApiKeyManagementAuth: requireAuthMock,
    requireAdmin: passthrough,
    requireTenantAdminForOrganization: passthrough,
    optionalAuth: (req: any, _res: any, next: any) => { setTestUser(req); next(); },
    requireCompanyAccess: passthrough,
    requireActiveSubscription: passthrough,
    requireSignedAgreement: passthrough,
    requireRole: () => passthrough,
    createRequireWorkingGroupLeader: () => passthrough,
    createRequireWorkingGroupMember: () => passthrough,
    refuseAnyApiKeyOnGlobalAdmin: () => false,
    // Composite chain for /api/admin/users routes — see auth.ts.
    // Captured-at-load-time references mean the per-export mocks above
    // can't propagate into the production array, so re-build it here.
    requireGlobalAdmin: [requireAuthMock, passthrough],
    invalidateSessionCache: vi.fn(),
    invalidateBanCache: vi.fn(),
    invalidateSessionsForUsers: vi.fn(),
    switchSessionOrganization: vi.fn(),
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

const adminState = {
  isAdmin: false,
  grantedUserId: undefined as string | undefined,
  unavailable: false,
  principals: [] as Array<{ id: string; authWorkosUserId?: string; email?: string | null }>,
  onLookup: undefined as (() => void) | undefined,
};
// Mock the lookup module directly. `my-content-service.ts` imports
// `isWebUserAAOAdmin` from `addie/admin-status-lookup.js` (the thin
// module created in PR #3758), so the test must intercept there.
// `addie/mcp/admin-tools.js` re-exports for legacy callers, but ESM
// re-exports are not call-routed through the original module — once
// the consumer points at `admin-status-lookup`, that's what gets
// resolved.
vi.mock('../../src/addie/admin-status-lookup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/addie/admin-status-lookup.js')>();
  const checkMembership = vi.fn(async (id: string) => {
    if (adminState.unavailable) throw new actual.AAOAdminLookupUnavailableError();
    return adminState.grantedUserId ? id === adminState.grantedUserId : adminState.isAdmin;
  });
  const resolve = async (principal: any, email?: string | null) => {
    const id = typeof principal === 'string' ? principal : principal.authWorkosUserId ?? principal.id;
    if (typeof principal !== 'string') adminState.principals.push(principal);
    adminState.onLookup?.();
    return actual.decideAAOAdminAccess(await checkMembership(id), typeof principal === 'string' ? email : principal.email);
  };
  return {
    ...actual,
    isWebUserAAOAdmin: checkMembership,
    resolveWebUserAAOAdminAccess: resolve,
    isAuthenticatedUserAAOAdmin: async (principal: any) => (await resolve(principal)).isAdmin,
  };
});
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
  let adminWgId: string;
  let privateWgId: string;
  const ADMIN_WG_SLUG = 'mc-test-platform-review-wg';
  const PRIVATE_WG_SLUG = 'mc-test-private-wg';
  const WG_SLUG = 'mc-test-wg';
  const ARCHIVED_WG_SLUG = 'mc-test-archived-wg';
  const USER_ID = 'user_my_content';
  const OTHER_USER_ID = 'user_my_content_other';
  const ELIGIBLE_ORG_ID = 'org_my_content_professional';
  const INELIGIBLE_USER_ID = 'user_my_content_ineligible';
  const RATE_LIMIT_USER_ID = 'user_mc_ratelimit_test';
  const ESCALATION_SUMMARY_PREFIX = 'mc-test-perspective-cleanup';

  async function ensureContentSubmissionEligibleUser(userId: string, email: string) {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, primary_organization_id)
       VALUES ($1, $2, 'Mary', 'Content', $3)
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         primary_organization_id = EXCLUDED.primary_organization_id,
         updated_at = NOW()`,
      [userId, email, ELIGIBLE_ORG_ID]
    );

    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, workos_membership_id, email, role, created_at, updated_at, synced_at)
       VALUES ($1, $2, $3, $4, 'member', NOW(), NOW(), NOW())
       ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET
         email = EXCLUDED.email,
         updated_at = NOW(),
         synced_at = NOW()`,
      [userId, ELIGIBLE_ORG_ID, `om_${userId}`, email]
    );
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    await pool.query(
      `INSERT INTO organizations
         (workos_organization_id, name, membership_tier, subscription_status, created_at, updated_at)
       VALUES ($1, 'My Content Professional Org', 'individual_professional', 'active', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET
         membership_tier = EXCLUDED.membership_tier,
         subscription_status = EXCLUDED.subscription_status,
         subscription_canceled_at = NULL,
         updated_at = NOW()`,
      [ELIGIBLE_ORG_ID]
    );

    // Ensure users exist
    await ensureContentSubmissionEligibleUser(USER_ID, 'mc@example.com');
    await ensureContentSubmissionEligibleUser(OTHER_USER_ID, 'mc-other@example.com');
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name)
       VALUES ($1, 'mc-ineligible@example.com', 'Sam', 'Adeyemi')
       ON CONFLICT (workos_user_id) DO UPDATE SET primary_organization_id = NULL`,
      [INELIGIBLE_USER_ID],
    );
    const extraGroups = await pool.query<{ id: string; slug: string }>(
      `INSERT INTO working_groups (name, slug, accepts_public_submissions, is_private)
       VALUES ('Platform review fixture', $1, true, false), ('Private committee fixture', $2, false, true)
       ON CONFLICT (slug) DO UPDATE SET accepts_public_submissions = EXCLUDED.accepts_public_submissions,
         is_private = EXCLUDED.is_private, status = 'active'
       RETURNING id, slug`,
      [ADMIN_WG_SLUG, PRIVATE_WG_SLUG],
    );
    adminWgId = extraGroups.rows.find(group => group.slug === ADMIN_WG_SLUG)!.id;
    privateWgId = extraGroups.rows.find(group => group.slug === PRIVATE_WG_SLUG)!.id;
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (working_group_id, workos_user_id) DO UPDATE SET status = 'active'`,
      [privateWgId, OTHER_USER_ID],
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
    await pool.query(`DELETE FROM addie_escalations WHERE summary LIKE $1`, [`${ESCALATION_SUMMARY_PREFIX}%`]);
    await pool.query(`DELETE FROM content_authors WHERE perspective_id IN (SELECT id FROM perspectives WHERE slug LIKE 'mc-test-%')`);
    await pool.query(`DELETE FROM perspectives WHERE slug LIKE 'mc-test-%'`);
    await pool.query(
      `DELETE FROM working_group_memberships
       WHERE working_group_id IN (SELECT id FROM working_groups WHERE slug = $1)`,
      [ARCHIVED_WG_SLUG]
    );
    await pool.query(`DELETE FROM working_groups WHERE slug = $1`, [ARCHIVED_WG_SLUG]);
    await pool.query(`DELETE FROM working_group_memberships WHERE working_group_id = $1`, [privateWgId]);
    await pool.query(`DELETE FROM working_groups WHERE id = ANY($1)`, [[adminWgId, privateWgId]]);
    await pool.query(`DELETE FROM working_group_leaders WHERE working_group_id = $1`, [wgId]);
    await pool.query(`DELETE FROM working_groups WHERE slug = $1`, [WG_SLUG]);
    // Side tables the propose flow writes into. Clear everything referencing
    // the test users before deleting them so FKs don't block cleanup.
    const testUsers = [USER_ID, OTHER_USER_ID, INELIGIBLE_USER_ID, RATE_LIMIT_USER_ID];
    await pool.query(`DELETE FROM community_points WHERE workos_user_id = ANY($1)`, [testUsers]);
    await pool.query(`DELETE FROM user_badges WHERE workos_user_id = ANY($1)`, [testUsers]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)`, [testUsers]);
    await pool.query(`UPDATE users SET primary_organization_id = NULL WHERE workos_user_id = ANY($1)`, [testUsers]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [ELIGIBLE_ORG_ID]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = ANY($1)`, [testUsers]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    adminState.isAdmin = false;
    adminState.grantedUserId = undefined;
    adminState.unavailable = false;
    adminState.principals = [];
    adminState.onLookup = undefined;
    authState.requestUser = undefined;
    authState.authWorkosUserId = undefined;
    authState.userId = USER_ID;
    authState.email = 'mc@example.com';
    await pool.query(`DELETE FROM addie_escalations WHERE summary LIKE $1`, [`${ESCALATION_SUMMARY_PREFIX}%`]);
    await pool.query(`DELETE FROM content_authors WHERE perspective_id IN (SELECT id FROM perspectives WHERE slug LIKE 'mc-test-%')`);
    await pool.query(`DELETE FROM perspectives WHERE slug LIKE 'mc-test-%'`);
  });

  function expectCapturedAuthority(credential: string) {
    expect(adminState.principals.length).toBeGreaterThan(0);
    for (const principal of adminState.principals) {
      expect(Object.isFrozen(principal)).toBe(true);
      expect(principal.authWorkosUserId ?? principal.id).toBe(credential);
      expect(principal).not.toBe(authState.requestUser);
    }
  }

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

    it.each([
      ['user_my_content', 'user_my_content_other', true],
      ['user_my_content_other', 'user_my_content', false],
    ] as const)('uses authenticated %s instead of canonical %s for platform scope', async (authenticated, canonical, allowed) => {
      await insertPerspective({ slug: 'mc-test-orphan', title: 'Unrelated official content', proposerUserId: null, workingGroupId: null });
      authState.userId = canonical;
      authState.authWorkosUserId = authenticated;
      adminState.grantedUserId = USER_ID;

      const response = await request(app).get('/api/me/content').expect(200);
      expect(response.body.items.some((item: { slug: string }) => item.slug === 'mc-test-orphan')).toBe(allowed);
    });

    it('reports an unavailable platform lookup separately from an empty personal list', async () => {
      adminState.unavailable = true;
      const response = await request(app).get('/api/me/content').expect(503);
      expect(response.body.error).toBe('admin_authorization_unavailable');
      expect(response.headers['retry-after']).toBe('5');
      expect(response.headers['cache-control']).toBe('no-store');
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
    it('rejects a non-HTTP external URL before creating a link perspective', async () => {
      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-unsafe-link',
          content_type: 'link',
          external_url: 'javascript:alert(document.domain)',
          collection: { slug: WG_SLUG },
        })
        .expect(400);

      expect(response.body.message).toMatch(/external_url.*HTTPS URL without credentials/i);
      const stored = await pool.query(`SELECT id FROM perspectives WHERE title = $1`, ['mc-test-unsafe-link']);
      expect(stored.rows).toHaveLength(0);
    });

    it('excludes archived working groups from collections and content proposals', async () => {
      const archivedWg = await pool.query<{ id: string }>(
        `INSERT INTO working_groups
           (name, slug, description, accepts_public_submissions, status)
         VALUES ('Archived Content Test WG', $1, 'lifecycle test', false, 'active')
         ON CONFLICT (slug) DO UPDATE SET
           accepts_public_submissions = false,
           status = 'active'
         RETURNING id`,
        [ARCHIVED_WG_SLUG]
      );
      const archivedWgId = archivedWg.rows[0].id;
      await pool.query(
        `INSERT INTO working_group_memberships
           (working_group_id, workos_user_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (working_group_id, workos_user_id)
         DO UPDATE SET status = 'active'`,
        [archivedWgId, USER_ID]
      );

      const activeCollections = await request(app).get('/api/content/collections').expect(200);
      expect(activeCollections.body.collections.map((collection: { slug: string }) => collection.slug))
        .toContain(ARCHIVED_WG_SLUG);

      await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-active-wg-proposal',
          content: 'body',
          content_type: 'article',
          collection: { slug: ARCHIVED_WG_SLUG },
        })
        .expect(201);

      await pool.query(`UPDATE working_groups SET status = 'archived' WHERE id = $1`, [archivedWgId]);

      const archivedCollections = await request(app).get('/api/content/collections').expect(200);
      expect(archivedCollections.body.collections.map((collection: { slug: string }) => collection.slug))
        .not.toContain(ARCHIVED_WG_SLUG);

      const archivedProposal = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-archived-wg-proposal',
          content: 'body',
          content_type: 'article',
          collection: { slug: ARCHIVED_WG_SLUG },
        })
        .expect(400);
      expect(archivedProposal.body.message).toContain('No collection found');
    });

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

    it('blocks users without a Professional+ membership tier', async () => {
      authState.userId = INELIGIBLE_USER_ID;
      authState.email = 'mc-ineligible@example.com';
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name)
         VALUES ($1, $2, 'Ineligible', 'User')
         ON CONFLICT (workos_user_id) DO UPDATE SET email = EXCLUDED.email`,
        [INELIGIBLE_USER_ID, authState.email]
      );

      const response = await request(app)
        .post('/api/content/propose')
        .send({
          title: 'mc-test-ineligible',
          content: 'body',
          content_type: 'article',
          collection: { slug: WG_SLUG },
        })
        .expect(403);

      expect(response.body.error).toBe('Membership required');
      expect(response.body.message).toContain('/dashboard/membership');
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
      const testUser = {
        id: RATE_LIMIT_USER_ID,
        email: 'ratelimit@test.local',
        adminPrincipal: Object.freeze({ id: RATE_LIMIT_USER_ID, email: 'ratelimit@test.local' }),
      };
      await ensureContentSubmissionEligibleUser(testUser.id, testUser.email);

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
    it('returns a proposer substantive edit of published content to review when status is omitted', async () => {
      authState.userId = OTHER_USER_ID;
      authState.email = 'mc-other@example.com';
      const id = await insertPerspective({
        slug: 'mc-test-published-proposer-edit',
        title: 'Published proposer article',
        proposerUserId: OTHER_USER_ID,
      });
      await pool.query(
        `UPDATE perspectives
         SET reviewed_by_user_id = 'prior-reviewer', reviewed_at = NOW(),
             revision_notes = 'stale notes', revision_requested_at = NOW(),
             rejection_reason = 'stale rejection reason'
         WHERE id = $1`,
        [id]
      );

      const response = await request(app)
        .put(`/api/me/content/${id}`)
        .send({ title: 'Revised proposer article' })
        .expect(200);

      expect(response.body.status).toBe('pending_review');
      expect(response.body.published_at).toBeNull();
      expect(response.body.proposed_at).not.toBeNull();
      expect(response.body.reviewed_by_user_id).toBeNull();
      expect(response.body.reviewed_at).toBeNull();
      expect(response.body.revision_notes).toBeNull();
      expect(response.body.revision_requested_at).toBeNull();
      expect(response.body.rejection_reason).toBeNull();
    });

    it('returns a committee lead substantive edit to review even when published is requested', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-published-lead-edit',
        title: 'Published committee article',
        proposerUserId: OTHER_USER_ID,
        workingGroupId: wgId,
      });

      const response = await request(app)
        .put(`/api/me/content/${id}`)
        .send({ title: 'Revised by committee lead', status: 'published' })
        .expect(200);

      expect(response.body.status).toBe('pending_review');
    });

    it('returns a co-author substantive edit to review even when published is requested', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-published-coauthor-edit',
        title: 'Published co-authored article',
        proposerUserId: USER_ID,
      });
      await pool.query(
        `INSERT INTO content_authors (perspective_id, user_id, display_name)
         VALUES ($1, $2, 'Co-author')`,
        [id, OTHER_USER_ID]
      );
      authState.userId = OTHER_USER_ID;
      authState.email = 'mc-other@example.com';

      const response = await request(app)
        .put(`/api/me/content/${id}`)
        .send({ excerpt: 'A co-author revision', status: 'published' })
        .expect(200);

      expect(response.body.status).toBe('pending_review');
    });

    it('still forbids a stranger from editing published content', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-published-stranger-edit',
        title: 'Someone else\'s published article',
        proposerUserId: USER_ID,
      });
      authState.userId = OTHER_USER_ID;
      authState.email = 'mc-other@example.com';

      await request(app)
        .put(`/api/me/content/${id}`)
        .send({ title: 'Unauthorized revision' })
        .expect(403);
    });

    it('preserves an admin override when editing published content', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-published-admin-edit',
        title: 'Published admin article',
        proposerUserId: OTHER_USER_ID,
      });
      adminState.isAdmin = true;

      const response = await request(app)
        .put(`/api/me/content/${id}`)
        .send({ title: 'Admin revision stays live', status: 'published' })
        .expect(200);

      expect(response.body.status).toBe('published');
      expect(response.body.published_at).not.toBeNull();
    });

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

  describe.each([
    { authority: 'leader', authenticated: 'user_my_content', canonical: 'user_my_content_other', allowed: true },
    { authority: 'platform administrator', authenticated: 'user_my_content', canonical: 'user_my_content_other', allowed: true },
    { authority: 'leader', authenticated: 'user_my_content_other', canonical: 'user_my_content', allowed: false },
    { authority: 'platform administrator', authenticated: 'user_my_content_other', canonical: 'user_my_content', allowed: false },
  ])('content $authority credential $authenticated linked to $canonical', ({ authority, authenticated, canonical, allowed }) => {
    let authorityGroupId: string;
    let authorityGroupSlug: string;
    beforeEach(() => {
      authState.userId = canonical;
      authState.authWorkosUserId = authenticated;
      adminState.grantedUserId = authority === 'platform administrator' ? USER_ID : undefined;
      authorityGroupId = authority === 'platform administrator' ? adminWgId : wgId;
      authorityGroupSlug = authority === 'platform administrator' ? ADMIN_WG_SLUG : WG_SLUG;
    });

    it('passes immutable exact authority through the my-content route', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-credential-my-content', title: 'Review-owned content',
        status: 'pending_review', proposerUserId: null, workingGroupId: authorityGroupId,
      });
      const response = await request(app).get('/api/me/content').query({ collection: authorityGroupSlug }).expect(200);
      expectCapturedAuthority(authenticated);
      expect(response.body.items.some((item: { id: string }) => item.id === id)).toBe(allowed);
    });

    it('passes the authenticated credential through the proposal route', async () => {
      const response = await request(app).post('/api/content/propose').send({
        title: 'mc-test-credential-proposal',
        adminPrincipal: { id: USER_ID }, authWorkosUserId: USER_ID,
        content: 'Credential-scoped publishing authority',
        content_type: 'article',
        collection: { slug: authorityGroupSlug },
        status: 'published',
      }).expect(201);

      expectCapturedAuthority(authenticated);
      const expectedStatus = allowed ? 'published' : 'pending_review';
      expect(response.body.status).toBe(expectedStatus);
      const stored = await pool.query(
        'SELECT status, proposer_user_id FROM perspectives WHERE id = $1', [response.body.id],
      );
      expect(stored.rows).toEqual([{ status: expectedStatus, proposer_user_id: canonical }]);
    });

    it('passes the authenticated credential through the pending-review route', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-credential-pending', title: 'Private pending submission',
        status: 'pending_review', proposerUserId: null, workingGroupId: authorityGroupId,
      });

      const response = await request(app).get('/api/content/pending')
        .query({ committee_slug: authorityGroupSlug }).expect(200);
      expectCapturedAuthority(authenticated);
      expect(response.body.items.some((item: { id: string }) => item.id === id)).toBe(allowed);
      if (!allowed) expect(response.body.items).toEqual([]);
    });

    it.each([
      { action: 'approve', body: { publish_immediately: false }, nextStatus: 'draft' },
      { action: 'reject', body: { reason: 'Please revise this submission' }, nextStatus: 'rejected' },
      { action: 'request-revisions', body: { notes: 'Please add supporting evidence' }, nextStatus: 'needs_revisions' },
    ])('passes the authenticated credential through the $action route', async ({ action, body, nextStatus }) => {
      const id = await insertPerspective({
        slug: `mc-test-credential-${action}`, title: 'Pending submission',
        status: 'pending_review', proposerUserId: null, workingGroupId: authorityGroupId,
      });

      const response = await request(app).post(`/api/content/${id}/${action}`).send({ ...body, adminPrincipal: { id: USER_ID }, authWorkosUserId: USER_ID })
        .expect(allowed ? 200 : 403);
      expectCapturedAuthority(authenticated);
      if (allowed) expect(response.body.status).toBe(nextStatus);
      const stored = await pool.query(
        'SELECT status, reviewed_by_user_id, reviewed_at FROM perspectives WHERE id = $1', [id],
      );
      expect(stored.rows[0]).toMatchObject({
        status: allowed ? nextStatus : 'pending_review',
        reviewed_by_user_id: allowed ? canonical : null,
      });
      expect(stored.rows[0].reviewed_at !== null).toBe(allowed);
    });

    it.each(['update', 'delete', 'add-author', 'remove-author'] as const)('uses exact credential for %s authority', async (operation) => {
      const id = await insertPerspective({
        slug: `mc-test-credential-${operation}`, title: 'Original title',
        status: 'draft', proposerUserId: null, workingGroupId: authorityGroupId,
      });
      if (operation === 'remove-author') {
        await pool.query(
          `INSERT INTO content_authors (perspective_id, user_id, display_name) VALUES ($1, $2, 'Existing author')`,
          [id, OTHER_USER_ID],
        );
      }

      const path = `/api/me/content/${id}`;
      const response = operation === 'update'
        ? await request(app).put(path).send({ title: 'Changed title' })
        : operation === 'delete'
          ? await request(app).delete(path)
          : operation === 'add-author'
            ? await request(app).post(`${path}/authors`).send({ user_id: OTHER_USER_ID, display_name: 'New author' })
            : await request(app).delete(`${path}/authors/${OTHER_USER_ID}`);
      expectCapturedAuthority(authenticated);
      expect(response.status).toBe(allowed ? operation === 'add-author' ? 201 : 200 : 403);

      if (operation === 'update' || operation === 'delete') {
        const stored = await pool.query(`SELECT title FROM perspectives WHERE id = $1`, [id]);
        expect(stored.rows).toEqual(allowed && operation === 'delete' ? [] : [{ title: allowed ? 'Changed title' : 'Original title' }]);
      } else {
        const authors = await pool.query(`SELECT user_id FROM content_authors WHERE perspective_id = $1`, [id]);
        const expectedCount = operation === 'add-author' ? Number(allowed) : Number(!allowed);
        expect(authors.rows).toHaveLength(expectedCount);
      }
    });

    it.each([
      { missing: 'user_id', body: { display_name: 'Untrusted author' } },
      { missing: 'display_name', body: { user_id: OTHER_USER_ID } },
    ])('authorizes before validating missing $missing or trusting body authority', async ({ body }) => {
      const id = await insertPerspective({
        slug: 'mc-test-credential-author-validation', title: 'Stored author authority',
        status: 'draft', proposerUserId: null, workingGroupId: authorityGroupId,
      });
      const response = await request(app).post(`/api/me/content/${id}/authors`).send({
        ...body,
        adminPrincipal: { id: USER_ID }, authWorkosUserId: USER_ID,
        proposer_user_id: canonical, isAdmin: true,
      });

      expect(response.status).toBe(allowed ? 400 : 403);
      expectCapturedAuthority(authenticated);
      expect((await pool.query('SELECT 1 FROM content_authors WHERE perspective_id = $1', [id])).rows).toEqual([]);
    });
  });

  describe.each([
    { authenticated: OTHER_USER_ID, canonical: INELIGIBLE_USER_ID, allowed: true },
    { authenticated: INELIGIBLE_USER_ID, canonical: OTHER_USER_ID, allowed: false },
  ])('paid submission credential $authenticated linked to $canonical', ({ authenticated, canonical, allowed }) => {
    it('uses the exact organization grant for the Professional tier gate and keeps canonical attribution', async () => {
      authState.userId = canonical;
      authState.authWorkosUserId = authenticated;
      const title = 'mc-test-linked-paid-tier';
      const response = await request(app).post('/api/content/propose').send({
        title, content: 'Tier-protected submission', content_type: 'article',
        collection: { slug: ADMIN_WG_SLUG },
        adminPrincipal: { id: OTHER_USER_ID }, authWorkosUserId: OTHER_USER_ID,
      }).expect(allowed ? 201 : 403);

      expectCapturedAuthority(authenticated);
      const stored = await pool.query('SELECT proposer_user_id, status FROM perspectives WHERE title = $1', [title]);
      expect(stored.rows).toEqual(allowed ? [{ proposer_user_id: canonical, status: 'pending_review' }] : []);
      if (!allowed) expect(response.body.message).toContain('/dashboard/membership');
    });
  });

  it('does not treat a paid primary organization pointer as an exact credential membership grant', async () => {
    authState.userId = OTHER_USER_ID;
    authState.authWorkosUserId = INELIGIBLE_USER_ID;
    await pool.query('UPDATE users SET primary_organization_id = $1 WHERE workos_user_id = $2', [ELIGIBLE_ORG_ID, INELIGIBLE_USER_ID]);
    try {
      const response = await request(app).post('/api/content/propose').send({
        title: 'mc-test-stale-paid-pointer', content: 'Must require an exact membership row',
        content_type: 'article', collection: { slug: ADMIN_WG_SLUG },
      }).expect(403);
      expect(response.body.message).toContain('/dashboard/membership');
      expectCapturedAuthority(INELIGIBLE_USER_ID);
      const stored = await pool.query("SELECT id FROM perspectives WHERE title = 'mc-test-stale-paid-pointer'");
      expect(stored.rows).toEqual([]);
    } finally {
      await pool.query('UPDATE users SET primary_organization_id = NULL WHERE workos_user_id = $1', [INELIGIBLE_USER_ID]);
    }
  });

  describe.each([
    { authenticated: OTHER_USER_ID, canonical: USER_ID, allowed: true },
    { authenticated: USER_ID, canonical: OTHER_USER_ID, allowed: false },
  ])('private committee member $authenticated linked to $canonical', ({ authenticated, canonical, allowed }) => {
    beforeEach(() => {
      authState.userId = canonical;
      authState.authWorkosUserId = authenticated;
    });

    it('lists the private collection only through exact credential membership', async () => {
      const response = await request(app).get('/api/content/collections').expect(200);
      expect(response.body.collections.some((collection: { slug: string }) => collection.slug === PRIVATE_WG_SLUG)).toBe(allowed);
    });

    it('checks exact private committee membership before inserting content', async () => {
      const title = 'mc-test-linked-private-committee';
      const response = await request(app).post('/api/content/propose').send({
        title, content: 'Private committee submission', content_type: 'article',
        collection: { slug: PRIVATE_WG_SLUG },
        adminPrincipal: { id: OTHER_USER_ID }, authWorkosUserId: OTHER_USER_ID,
      }).expect(allowed ? 201 : 403);

      expectCapturedAuthority(authenticated);
      const stored = await pool.query('SELECT proposer_user_id, working_group_id FROM perspectives WHERE title = $1', [title]);
      expect(stored.rows).toEqual(allowed ? [{ proposer_user_id: canonical, working_group_id: privateWgId }] : []);
      if (!allowed) expect(response.body.message).toContain('must be a member of this committee');
    });
  });

  it.each([
    { authenticated: USER_ID, canonical: OTHER_USER_ID, allowed: true },
    { authenticated: OTHER_USER_ID, canonical: USER_ID, allowed: false },
  ])('captures immutable principal and attribution before an awaited lookup for $authenticated', async ({ authenticated, canonical, allowed }) => {
    authState.userId = canonical;
    authState.authWorkosUserId = authenticated;
    adminState.grantedUserId = USER_ID;
    let changed = false;
    adminState.onLookup = () => {
      if (changed) return;
      changed = true;
      // Model another middleware/service holding the original req.user object.
      // The route must have captured its authority and attribution before I/O.
      authState.requestUser!.id = authenticated;
      authState.requestUser!.authWorkosUserId = canonical;
      authState.requestUser!.email = 'changed@example.com';
    };

    const response = await request(app).post('/api/content/propose').send({
      title: 'mc-test-immutable-request-principal', content: 'Snapshot principal through asynchronous work',
      content_type: 'article', collection: { slug: ADMIN_WG_SLUG }, status: 'published',
      adminPrincipal: { id: USER_ID }, authWorkosUserId: USER_ID,
    }).expect(201);

    expect(changed).toBe(true);
    expectCapturedAuthority(authenticated);
    const stored = await pool.query('SELECT proposer_user_id, status FROM perspectives WHERE id = $1', [response.body.id]);
    expect(stored.rows).toEqual([{ proposer_user_id: canonical, status: allowed ? 'published' : 'pending_review' }]);
  });

  it.each([null, undefined])('my-content missing principal %s cannot recover canonical leadership or admin scope', async (principal) => {
    const { listMyContent } = await import('../../src/services/my-content-service.js');
    const owned = await insertPerspective({
      slug: 'mc-test-principal-omitted-owned', title: 'Canonical attribution remains available',
      status: 'draft', proposerUserId: USER_ID,
    });
    const reviewOnly = await insertPerspective({
      slug: 'mc-test-principal-omitted-review', title: 'Committee review authority is separate',
      status: 'pending_review', proposerUserId: null, workingGroupId: wgId,
    });
    adminState.grantedUserId = USER_ID;
    // Exercise a runtime legacy caller omitting the now-required field.
    const result = await listMyContent({ userId: USER_ID, adminPrincipal: principal as null });
    expect(result.items.map(item => item.id)).toContain(owned);
    expect(result.items.map(item => item.id)).not.toContain(reviewOnly);
    expect(result.items.every(item => !item.relationships.includes('owner'))).toBe(true);
    expect(adminState.principals).toEqual([]);
  });

  describe('DELETE /api/admin/content/:id', () => {
    it('resolves linked open escalations before deleting the perspective', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-admin-delete-escalation',
        title: 'delete and resolve escalation',
        status: 'published',
        proposerUserId: OTHER_USER_ID,
      });
      const escalation = await pool.query(
        `INSERT INTO addie_escalations
           (category, summary, status, perspective_id, perspective_slug)
         VALUES ('needs_human_action', $1, 'open', $2, 'mc-test-admin-delete-escalation')
         RETURNING id`,
        [`${ESCALATION_SUMMARY_PREFIX}-delete`, id]
      );

      await request(app).delete(`/api/admin/content/${id}`).expect(200);

      const result = await pool.query(
        `SELECT status, resolved_by, resolution_notes, perspective_id
         FROM addie_escalations WHERE id = $1`,
        [escalation.rows[0].id]
      );
      expect(result.rows[0]).toMatchObject({
        status: 'resolved',
        resolved_by: USER_ID,
        resolution_notes: 'Auto-resolved: content deleted by admin',
        perspective_id: null,
      });
    });

    it('rolls back escalation resolution when deleting the perspective fails', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-admin-delete-rollback',
        title: 'failed delete keeps escalation open',
        status: 'published',
        proposerUserId: OTHER_USER_ID,
      });
      const escalation = await pool.query(
        `INSERT INTO addie_escalations
           (category, summary, status, perspective_id, perspective_slug)
         VALUES ('needs_human_action', $1, 'open', $2, 'mc-test-admin-delete-rollback')
         RETURNING id`,
        [`${ESCALATION_SUMMARY_PREFIX}-delete-rollback`, id]
      );

      await pool.query(`
        CREATE OR REPLACE FUNCTION mc_test_reject_perspective_delete()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.slug = 'mc-test-admin-delete-rollback' THEN
            RAISE EXCEPTION 'intentional perspective delete failure';
          END IF;
          RETURN OLD;
        END;
        $$;
        DROP TRIGGER IF EXISTS mc_test_reject_perspective_delete ON perspectives;
        CREATE TRIGGER mc_test_reject_perspective_delete
          BEFORE DELETE ON perspectives
          FOR EACH ROW EXECUTE FUNCTION mc_test_reject_perspective_delete();
      `);

      try {
        await request(app).delete(`/api/admin/content/${id}`).expect(500);

        const perspective = await pool.query(`SELECT id FROM perspectives WHERE id = $1`, [id]);
        const escalationResult = await pool.query(
          `SELECT status, resolved_by, resolved_at FROM addie_escalations WHERE id = $1`,
          [escalation.rows[0].id]
        );
        expect(perspective.rows).toHaveLength(1);
        expect(escalationResult.rows[0]).toMatchObject({
          status: 'open',
          resolved_by: null,
          resolved_at: null,
        });
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS mc_test_reject_perspective_delete ON perspectives`);
        await pool.query(`DROP FUNCTION IF EXISTS mc_test_reject_perspective_delete()`);
      }
    });

    it('deletes linked content while preserving publication history', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-admin-delete-linked',
        title: 'linked publication',
        status: 'published',
        proposerUserId: OTHER_USER_ID,
      });

      const weeklyDigest = await pool.query(
        `INSERT INTO weekly_digests (edition_date, status, content, perspective_id)
         VALUES ('2999-01-01', 'sent', '{}'::jsonb, $1)
         RETURNING id`,
        [id]
      );
      const buildEdition = await pool.query(
        `INSERT INTO build_editions (edition_date, status, content, perspective_id)
         VALUES ('2999-01-02', 'sent', '{}'::jsonb, $1)
         RETURNING id`,
        [id]
      );
      const moltbookPost = await pool.query(
        `INSERT INTO moltbook_posts (moltbook_post_id, perspective_id, title)
         VALUES ('mc-test-admin-delete-linked', $1, 'Linked publication')
         RETURNING id`,
        [id]
      );

      try {
        await request(app).delete(`/api/admin/content/${id}`).expect(200);

        const perspective = await pool.query(`SELECT id FROM perspectives WHERE id = $1`, [id]);
        expect(perspective.rows).toHaveLength(0);

        const links = await pool.query(
          `SELECT perspective_id FROM weekly_digests WHERE id = $1
           UNION ALL
           SELECT perspective_id FROM build_editions WHERE id = $2
           UNION ALL
           SELECT perspective_id FROM moltbook_posts WHERE id = $3`,
          [weeklyDigest.rows[0].id, buildEdition.rows[0].id, moltbookPost.rows[0].id]
        );
        expect(links.rows).toHaveLength(3);
        expect(links.rows.every(row => row.perspective_id === null)).toBe(true);
      } finally {
        await pool.query(`DELETE FROM weekly_digests WHERE id = $1`, [weeklyDigest.rows[0].id]);
        await pool.query(`DELETE FROM build_editions WHERE id = $1`, [buildEdition.rows[0].id]);
        await pool.query(`DELETE FROM moltbook_posts WHERE id = $1`, [moltbookPost.rows[0].id]);
      }
    });
  });

  describe('PUT /api/admin/content/:id/status', () => {
    it('resolves linked open escalations when an admin archives content', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-admin-archive-escalation',
        title: 'archive and resolve escalation',
        status: 'published',
        proposerUserId: OTHER_USER_ID,
      });
      const escalation = await pool.query(
        `INSERT INTO addie_escalations
           (category, summary, status, perspective_id, perspective_slug)
         VALUES ('needs_human_action', $1, 'open', $2, 'mc-test-admin-archive-escalation')
         RETURNING id`,
        [`${ESCALATION_SUMMARY_PREFIX}-archive`, id]
      );

      const response = await request(app)
        .put(`/api/admin/content/${id}/status`)
        .send({ status: 'archived' })
        .expect(200);

      expect(response.body.status).toBe('archived');
      const result = await pool.query(
        `SELECT status, resolved_by, resolution_notes, perspective_id
         FROM addie_escalations WHERE id = $1`,
        [escalation.rows[0].id]
      );
      expect(result.rows[0]).toMatchObject({
        status: 'resolved',
        resolved_by: USER_ID,
        resolution_notes: 'Auto-resolved: content archived by admin',
        perspective_id: id,
      });
    });

    it('rolls back the archive when escalation resolution fails', async () => {
      const id = await insertPerspective({
        slug: 'mc-test-admin-archive-rollback',
        title: 'failed escalation cleanup keeps content published',
        status: 'published',
        proposerUserId: OTHER_USER_ID,
      });
      const escalation = await pool.query(
        `INSERT INTO addie_escalations
           (category, summary, status, perspective_id, perspective_slug)
         VALUES ('needs_human_action', $1, 'open', $2, 'mc-test-admin-archive-rollback')
         RETURNING id`,
        [`${ESCALATION_SUMMARY_PREFIX}-archive-rollback`, id]
      );

      await pool.query(`
        CREATE OR REPLACE FUNCTION mc_test_reject_escalation_resolution()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.summary = 'mc-test-perspective-cleanup-archive-rollback'
             AND NEW.status = 'resolved' THEN
            RAISE EXCEPTION 'intentional escalation resolution failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        DROP TRIGGER IF EXISTS mc_test_reject_escalation_resolution ON addie_escalations;
        CREATE TRIGGER mc_test_reject_escalation_resolution
          BEFORE UPDATE ON addie_escalations
          FOR EACH ROW EXECUTE FUNCTION mc_test_reject_escalation_resolution();
      `);

      try {
        await request(app)
          .put(`/api/admin/content/${id}/status`)
          .send({ status: 'archived' })
          .expect(500);

        const perspective = await pool.query(`SELECT status FROM perspectives WHERE id = $1`, [id]);
        const escalationResult = await pool.query(
          `SELECT status, resolved_by, resolved_at FROM addie_escalations WHERE id = $1`,
          [escalation.rows[0].id]
        );
        expect(perspective.rows[0].status).toBe('published');
        expect(escalationResult.rows[0]).toMatchObject({
          status: 'open',
          resolved_by: null,
          resolved_at: null,
        });
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS mc_test_reject_escalation_resolution ON addie_escalations`);
        await pool.query(`DROP FUNCTION IF EXISTS mc_test_reject_escalation_resolution()`);
      }
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
