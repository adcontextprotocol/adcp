/**
 * Unit tests for platform-admin and explicit tenant-admin boundaries.
 * `requireAdmin` rejects every tenant WorkOS key; the audited
 * `requireTenantAdminForOrganization` middleware grants only permission- and
 * issuer-bound access to a literal `:orgId` target.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// requireAdmin imports WorkOS at module load. Keep these local defaults so
// this file runs under both root Vitest config and server/vitest.config.ts.
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test_mock_key';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_mock_id';
process.env.WORKOS_COOKIE_PASSWORD =
  process.env.WORKOS_COOKIE_PASSWORD ??
  'test-cookie-password-at-least-32-chars-long';

const {
  requireAdmin,
  requireTenantAdminForOrganization,
  requireAuth,
  requireGlobalAdmin,
  stopAuthTimers,
} = await import('../../src/middleware/auth.js');

afterAll(() => {
  stopAuthTimers();
});

describe('requireAdmin cross-tenant API key defense', () => {
  let app: express.Application;

  beforeAll(() => {
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

    app.get('/api/admin/accounts/:orgId/agents', requireTenantAdminForOrganization, (_req, res) => {
      res.json({ ok: true });
    });

    app.delete(
      '/api/admin/accounts/:orgId/agents/:url',
      requireTenantAdminForOrganization,
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    app.post(
      '/api/admin/accounts/:orgId/agents',
      requireTenantAdminForOrganization,
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    // Route without :orgId — tenant-scoped keys must fail closed because
    // there is no organization target to bind to the key's issuer.
    app.get('/api/admin/stats', requireAdmin, (_req, res) => {
      res.json({ ok: true });
    });

    // A matching org parameter does not make a platform financial route safe
    // for tenant keys. Only the explicit tenant middleware above may do that.
    app.post('/api/admin/organizations/:orgId/discount', requireAdmin, (_req, res) => {
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

  it('refuses cross-tenant on POST the same way as GET', async () => {
    const res = await request(app)
      .post('/api/admin/accounts/org_target/agents')
      .set('x-test-api-key-org-id', 'org_caller');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_tenant_api_key');
  });

  it('refuses a tenant-scoped admin:* key on routes without a :orgId path param', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set('x-test-api-key-org-id', 'org_caller');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('global_admin_required');
  });

  it('refuses a tenant key on a platform-admin route even when :orgId matches', async () => {
    const res = await request(app)
      .post('/api/admin/organizations/org_same/discount')
      .set('x-test-api-key-org-id', 'org_same');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('global_admin_required');
  });

  it('lets the static admin_api_key through cross-tenant routes (not tenant-scoped)', async () => {
    const res = await request(app)
      .get('/api/admin/accounts/org_target/agents')
      .set('x-test-static-admin', '1');

    expect(res.status).toBe(200);
  });

  it('lets the static admin_api_key through platform-global routes', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
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

  it('still rejects admin:read for same-tenant POST operations', async () => {
    const res = await request(app)
      .post('/api/admin/accounts/org_same/agents')
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

describe('requireGlobalAdmin composite middleware', () => {
  it('composes authentication before the platform-admin boundary', () => {
    expect(requireGlobalAdmin).toHaveLength(2);
    expect(requireGlobalAdmin[0]).toBe(requireAuth);
    expect(requireGlobalAdmin[1]).toBe(requireAdmin);
  });
});
