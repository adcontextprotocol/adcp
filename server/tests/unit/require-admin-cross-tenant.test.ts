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
