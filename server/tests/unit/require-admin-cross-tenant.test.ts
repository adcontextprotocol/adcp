/**
 * Unit tests for the cross-tenant defense added to `requireAdmin`.
 *
 * Surfaced by the security review on PR #4609 / issue #4501: a WorkOS
 * API key carrying `admin:*` is tenant-scoped by issuance (the
 * permission grants admin within the issuing org, not across orgs).
 * Before this gate, any org holding such a key could mutate any other
 * org's data via admin routes whose path resolves a target org.
 *
 * Exercises the REAL middleware (not a mock) by stubbing the upstream
 * `req.apiKey`/`req.params` shape that auth-and-routing would have set
 * by the time control reaches `requireAdmin`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// requireAdmin reads ADMIN_EMAILS lazily; populate before import so the
// SSO-admin branch is reachable in tests that want it. WorkOS init
// happens at module-load — give it placeholder env so the import works.
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
process.env.WORKOS_COOKIE_PASSWORD =
  process.env.WORKOS_COOKIE_PASSWORD ??
  'placeholder-cookie-password-32-bytes-min';

describe('requireAdmin cross-tenant API key defense', () => {
  let app: express.Application;

  beforeAll(async () => {
    const { requireAdmin } = await import('../../src/middleware/auth.js');

    app = express();

    // Helper that lets each test set req.apiKey and req.params.orgId
    // before requireAdmin runs.
    app.use((req, _res, next) => {
      const apiKeyHeader = req.headers['x-test-api-key-org-id'];
      const permsHeader = req.headers['x-test-api-key-perms'];
      if (typeof apiKeyHeader === 'string') {
        (req as any).apiKey = {
          id: 'apikey_test',
          organizationId: apiKeyHeader,
          permissions:
            typeof permsHeader === 'string' ? permsHeader.split(',') : ['admin:*'],
        };
      }
      const staticAdminHeader = req.headers['x-test-static-admin'];
      if (staticAdminHeader === '1') {
        (req as any).isStaticAdminApiKey = true;
      }
      next();
    });

    app.get('/api/admin/accounts/:orgId/agents', requireAdmin, (_req, res) => {
      res.json({ ok: true });
    });

    app.delete(
      '/api/admin/accounts/:orgId/agents/:url',
      requireAdmin,
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    // Route without :orgId — gate should NOT engage even with a
    // tenant-scoped API key; this proves the check is opt-in by path
    // convention rather than blanket-deny.
    app.get('/api/admin/stats', requireAdmin, (_req, res) => {
      res.json({ ok: true });
    });
  });

  it('refuses an admin:* API key when its issuing org does not match :orgId', async () => {
    const res = await request(app)
      .get('/api/admin/accounts/org_target/agents')
      .set('x-test-api-key-org-id', 'org_caller');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_tenant_api_key');
    expect(res.body.message).toContain('org_caller');
    expect(res.body.message).toContain('org_target');
  });

  it('allows an admin:* API key when its issuing org matches :orgId', async () => {
    const res = await request(app)
      .get('/api/admin/accounts/org_same/agents')
      .set('x-test-api-key-org-id', 'org_same');

    expect(res.status).toBe(200);
  });

  it('refuses cross-tenant on DELETE the same way as GET', async () => {
    const res = await request(app)
      .delete('/api/admin/accounts/org_target/agents/some_url')
      .set('x-test-api-key-org-id', 'org_caller');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_tenant_api_key');
  });

  it('does NOT engage on routes without a :orgId path param', async () => {
    // A tenant-scoped key with admin:* hitting a non-tenant-scoped admin
    // route should still pass — the check is convention-based on the
    // route shape, not a blanket allow-list.
    const res = await request(app)
      .get('/api/admin/stats')
      .set('x-test-api-key-org-id', 'org_caller');

    expect(res.status).toBe(200);
  });

  it('lets the static admin_api_key through cross-tenant routes (not tenant-scoped)', async () => {
    const res = await request(app)
      .get('/api/admin/accounts/org_target/agents')
      .set('x-test-static-admin', '1');

    expect(res.status).toBe(200);
  });

  it('still rejects keys with admin:read for write operations on the matched org', async () => {
    // Same-tenant admin:read key — the cross-tenant gate passes, then the
    // existing permission check rejects the DELETE because admin:read is
    // not sufficient for writes.
    const res = await request(app)
      .delete('/api/admin/accounts/org_same/agents/some_url')
      .set('x-test-api-key-org-id', 'org_same')
      .set('x-test-api-key-perms', 'admin:read');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('allows admin:read same-tenant on GET (cross-tenant gate is independent of method)', async () => {
    const res = await request(app)
      .get('/api/admin/accounts/org_same/agents')
      .set('x-test-api-key-org-id', 'org_same')
      .set('x-test-api-key-perms', 'admin:read');

    expect(res.status).toBe(200);
  });

  it('refuses admin:read cross-tenant even on GET', async () => {
    const res = await request(app)
      .get('/api/admin/accounts/org_target/agents')
      .set('x-test-api-key-org-id', 'org_caller')
      .set('x-test-api-key-perms', 'admin:read');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_tenant_api_key');
  });
});

describe('refuseCrossTenantAdminApiKey + refuseAnyApiKeyOnGlobalAdmin helpers', () => {
  let app: express.Application;

  beforeAll(async () => {
    const { refuseCrossTenantAdminApiKey, refuseAnyApiKeyOnGlobalAdmin } =
      await import('../../src/middleware/auth.js');

    app = express();

    app.use((req, _res, next) => {
      const apiKeyHeader = req.headers['x-test-api-key-org-id'];
      if (typeof apiKeyHeader === 'string') {
        (req as any).apiKey = {
          id: 'apikey_test',
          organizationId: apiKeyHeader,
          permissions: ['admin:*'],
        };
      }
      next();
    });

    // Route keyed on a UUID-style :id with the target org resolved
    // dynamically (mimics /api/admin/member-profiles/:id PUT/DELETE).
    // The handler invokes refuseCrossTenantAdminApiKey after the lookup.
    app.put('/profiles/:id', (req, res) => {
      const targetOrgId = req.headers['x-test-resolved-org'] as string;
      if (refuseCrossTenantAdminApiKey(req, res, targetOrgId)) return;
      res.json({ ok: true });
    });

    // Route operating on global state (mimics /api/admin/users/:userId/*).
    app.put('/users/:userId/name', (req, res) => {
      if (refuseAnyApiKeyOnGlobalAdmin(req, res)) return;
      res.json({ ok: true });
    });
  });

  it('refuses cross-tenant API key on a profile UUID route', async () => {
    const res = await request(app)
      .put('/profiles/profile-xyz')
      .set('x-test-api-key-org-id', 'org_caller')
      .set('x-test-resolved-org', 'org_target');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_tenant_api_key');
  });

  it('allows same-tenant API key on a profile UUID route', async () => {
    const res = await request(app)
      .put('/profiles/profile-xyz')
      .set('x-test-api-key-org-id', 'org_same')
      .set('x-test-resolved-org', 'org_same');
    expect(res.status).toBe(200);
  });

  it('allows the route when no api key is present (SSO admin / static admin)', async () => {
    const res = await request(app)
      .put('/profiles/profile-xyz')
      .set('x-test-resolved-org', 'org_target');
    expect(res.status).toBe(200);
  });

  it('refuses ANY tenant-scoped API key on a global-admin route', async () => {
    const res = await request(app)
      .put('/users/userid_abc/name')
      .set('x-test-api-key-org-id', 'org_caller');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('global_admin_required');
  });

  it('allows the global-admin route when no api key is present', async () => {
    const res = await request(app).put('/users/userid_abc/name');
    expect(res.status).toBe(200);
  });
});

describe('requireGlobalAdmin composite middleware', () => {
  // The composite chain wraps `requireAuth` + the cross-tenant refusal
  // + `requireAdmin` so a router can opt into "this whole surface is
  // global-state admin only" via `...requireGlobalAdmin` instead of
  // remembering to add a per-handler gate. The 7 originally-unprotected
  // `/api/admin/users` routes are the motivating case (security review
  // on #4646: per-handler enforcement risked silent regression every
  // time a new route was added). Full end-to-end coverage of the
  // chain belongs in the admin-users integration tests where real
  // requireAuth has a real session to validate; here we pin the
  // composition shape so a future refactor doesn't silently re-order
  // or drop a middleware from the chain.
  it('is a 3-element middleware array in the documented order', async () => {
    const { requireGlobalAdmin, requireAuth, requireAdmin } = await import(
      '../../src/middleware/auth.js'
    );
    expect(requireGlobalAdmin).toHaveLength(3);
    // First and last are the existing requireAuth / requireAdmin
    // exports; the middle is the chain's new contribution. Pinning
    // identities here means a future "I'll just swap in a different
    // requireAuth" refactor has to update the test, surfacing the
    // change explicitly.
    expect(requireGlobalAdmin[0]).toBe(requireAuth);
    expect(requireGlobalAdmin[2]).toBe(requireAdmin);
    expect(typeof requireGlobalAdmin[1]).toBe('function');
  });

  it('the middle middleware refuses an apiKey-bearing request and short-circuits next()', async () => {
    const { requireGlobalAdmin } = await import('../../src/middleware/auth.js');
    const middle = requireGlobalAdmin[1];

    let nextCalled = false;
    const calls: { status?: number; body?: unknown } = {};
    const req = { apiKey: { id: 'k', organizationId: 'org_caller', permissions: ['admin:*'] }, path: '/x', method: 'GET' } as any;
    const res = {
      status(code: number) {
        calls.status = code;
        return this;
      },
      json(body: unknown) {
        calls.body = body;
        return this;
      },
    } as any;
    await middle(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(calls.status).toBe(403);
    expect((calls.body as { error?: string })?.error).toBe('global_admin_required');
  });

  it('the middle middleware calls next() when no apiKey is present', async () => {
    const { requireGlobalAdmin } = await import('../../src/middleware/auth.js');
    const middle = requireGlobalAdmin[1];

    let nextCalled = false;
    const req = { path: '/x', method: 'GET' } as any;
    const res = {} as any;
    await middle(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
