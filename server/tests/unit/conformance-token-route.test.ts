import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.CONFORMANCE_JWT_SECRET = 'test-conformance-secret';

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_test', email: 'test@test' };
    next();
  },
}));

vi.mock('../../src/routes/helpers/resolve-caller-org.js', () => ({
  resolveCallerOrgId: vi.fn(async (req: any) => req.headers['x-test-org'] ?? null),
}));

async function buildApp() {
  const { buildConformanceTokenRouter } = await import('../../src/conformance/token-route.js');
  const app = express();
  app.use(express.json());
  app.use('/api/conformance', buildConformanceTokenRouter());
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
});
