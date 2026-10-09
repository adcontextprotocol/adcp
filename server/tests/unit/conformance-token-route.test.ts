import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.CONFORMANCE_JWT_SECRET = 'test-conformance-secret';

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_test', email: 'test@test' };
    req.isStaticAdminApiKey = req.headers['x-test-static-admin'] === 'true';
    next();
  },
}));

vi.mock('../../src/routes/helpers/resolve-caller-org.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/helpers/resolve-caller-org.js')>();
  return {
    ...actual,
    resolveCallerOrgId: vi.fn(async (req: express.Request) => {
      const status = Number(req.headers['x-test-auth-error']);
      if (status === 401 || status === 503) throw new actual.CallerOrganizationAuthError(status);
      return req.headers['x-test-org'] ?? null;
    }),
  };
});

async function buildApp() {
  const { buildConformanceTokenRouter } = await import('../../src/conformance/token-route.js');
  const app = express();
  app.use(express.json());
  app.use('/api/conformance', buildConformanceTokenRouter());
  // Model the production generic handler, which otherwise flattens 5xx to 500.
  const errorHandler: express.ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);
  return app;
}

describe('POST /api/conformance/token', () => {
  beforeEach(() => {
    process.env.CONFORMANCE_JWT_SECRET = 'test-conformance-secret';
  });

  it('issues a token bound to the resolved org', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/conformance/token')
      .set('x-test-org', 'org_real');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.url).toMatch(/\/conformance\/connect$/);
    expect(res.body.ttl_seconds).toBe(3600);
    expect(res.body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns 403 when the caller has no org', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/conformance/token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_organization');
  });

  it('uses CONFORMANCE_WS_PUBLIC_URL when set', async () => {
    process.env.CONFORMANCE_WS_PUBLIC_URL = 'wss://addie.example.com/conformance/connect';
    const app = await buildApp();
    const res = await request(app)
      .post('/api/conformance/token')
      .set('x-test-org', 'org_real');
    expect(res.body.url).toBe('wss://addie.example.com/conformance/connect');
    delete process.env.CONFORMANCE_WS_PUBLIC_URL;
  });

  it('returns 500 with a useful error when the secret is missing', async () => {
    delete process.env.CONFORMANCE_JWT_SECRET;
    const app = await buildApp();
    const res = await request(app)
      .post('/api/conformance/token')
      .set('x-test-org', 'org_real');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('token_issuance_failed');
  });

  it.each([401, 503])('preserves resolver status %s at every conformance credential boundary', async (status) => {
    const app = await buildApp();
    for (const [method, path] of [['post', '/token'], ['get', '/_debug'], ['post', '/_debug/run-storyboard']] as const) {
      const res = await request(app)[method](`/api/conformance${path}`)
        .set('Authorization', 'Bearer sk_selected').set('Cookie', 'wos-session=otherwise-valid')
        .set('x-test-auth-error', String(status));
      expect(res.status, path).toBe(status);
      expect(res.body.error).toBe(status === 401 ? 'invalid_bearer_token' : 'authorization_unavailable');
      expect(res.body.token).toBeUndefined();
    }
  });

  it('keeps authenticated static-admin dev smoke selection explicit without resolving a tenant', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/conformance/_debug/run-storyboard')
      .set('x-test-static-admin', 'true').set('x-test-auth-error', '401').send({ org_id: 'org_selected' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('storyboard_id required');
  });
});
