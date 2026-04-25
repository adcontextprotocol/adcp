/**
 * Integration-style tests for the admin "Mark posted to LinkedIn" HTTP
 * route. Exercises the middleware chain, orgId regex, ADMIN_API_KEY
 * guard, outcome→status code mapping, and the Slack-refresh fire-and-
 * forget — all the wiring that the shared-function unit tests can't
 * cover because they call `markLinkedInPosted` directly.
 *
 * Uses a bare Express app with `setupAccountRoutes`; auth middleware
 * and `markLinkedInPosted` / `refreshReviewCardForOrg` are mocked at
 * module boundaries. No DB, no real Slack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { Router } from 'express';
import request from 'supertest';

// Route module transitively imports workos-client which throws on
// module load if this isn't set. Any value works — the client is never
// called in these tests because we mock the admin-tools boundary.
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const {
  mockMarkLinkedInPosted,
  mockRefreshReviewCardForOrg,
  mockLoadDraftAndState,
  mockCurrentUser,
} = vi.hoisted(() => ({
  mockMarkLinkedInPosted: vi.fn<any>(),
  mockRefreshReviewCardForOrg: vi.fn<any>(),
  mockLoadDraftAndState: vi.fn<any>(),
  mockCurrentUser: { id: 'user_wk_admin01', email: 'admin@example.com', is_admin: true },
}));

vi.mock('../../server/src/addie/jobs/announcement-handlers.js', () => ({
  markLinkedInPosted: (...args: unknown[]) => mockMarkLinkedInPosted(...args),
  refreshReviewCardForOrg: (...args: unknown[]) => mockRefreshReviewCardForOrg(...args),
  loadDraftAndState: (...args: unknown[]) => mockLoadDraftAndState(...args),
}));

vi.mock('../../server/src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = mockCurrentUser;
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Everything else the route module imports but doesn't need for these
// tests — we stub with enough to make module init a no-op.
vi.mock('../../server/src/db/client.js', () => ({
  getPool: () => ({ query: vi.fn() }),
}));
vi.mock('../../server/src/billing/stripe-client.js', () => ({
  getPendingInvoices: vi.fn(),
  createCheckoutSession: vi.fn(),
  getProductsForCustomer: vi.fn(),
}));

async function buildApp() {
  const { setupAccountRoutes } = await import('../../server/src/routes/admin/accounts.js');
  const app = express();
  app.use(express.json());
  const pageRouter = Router();
  const apiRouter = Router();
  setupAccountRoutes(pageRouter, apiRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

const ORG_ID = 'org_ACME123';

beforeEach(() => {
  // Under pool:'threads' (see vitest.config.ts), the module registry is shared
  // across concurrent test files. Without this, a cached module from another
  // thread bleeds into this file's await import() calls — causing stale-mock
  // TypeErrors that only appear under Conductor multi-workspace load.
  vi.resetModules();
  vi.clearAllMocks();
  mockCurrentUser.id = 'user_wk_admin01';
  mockRefreshReviewCardForOrg.mockResolvedValue(undefined);
});

describe('POST /api/admin/accounts/:orgId/announcement/linkedin', () => {
  it('400 on malformed orgId', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/admin/accounts/not-an-org/announcement/linkedin')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid organization id');
    expect(mockMarkLinkedInPosted).not.toHaveBeenCalled();
  });

  it('403 when the caller is the static ADMIN_API_KEY', async () => {
    mockCurrentUser.id = 'admin_api_key';
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin_api_key_not_allowed');
    expect(mockMarkLinkedInPosted).not.toHaveBeenCalled();
  });

  it('404 when markLinkedInPosted returns no_draft', async () => {
    mockMarkLinkedInPosted.mockResolvedValueOnce({ kind: 'no_draft' });
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_draft');
  });

  it('409 when markLinkedInPosted refuses', async () => {
    mockMarkLinkedInPosted.mockResolvedValueOnce({
      kind: 'refuse',
      draft: {},
      state: {},
      notice: 'This announcement was already skipped.',
    });
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('refused');
    expect(res.body.message).toMatch(/already skipped/);
  });

  it('200 + already_done:true when the row already exists', async () => {
    mockMarkLinkedInPosted.mockResolvedValueOnce({
      kind: 'already_done',
      draft: {},
      state: {},
      notice: 'LinkedIn post was already marked.',
    });
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, already_done: true });
    expect(res.body.message).toMatch(/already marked/);
  });

  it('200 + already_done:false when a fresh record was written', async () => {
    mockMarkLinkedInPosted.mockResolvedValueOnce({
      kind: 'recorded',
      draft: {},
      state: {},
    });
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, already_done: false });
  });

  it('calls refreshReviewCardForOrg fire-and-forget on success paths', async () => {
    mockMarkLinkedInPosted.mockResolvedValueOnce({ kind: 'recorded', draft: {}, state: {} });
    const app = await buildApp();
    await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(mockRefreshReviewCardForOrg).toHaveBeenCalledWith(ORG_ID);
  });

  it('does NOT call refreshReviewCardForOrg on error paths', async () => {
    mockMarkLinkedInPosted.mockResolvedValueOnce({ kind: 'no_draft' });
    const app = await buildApp();
    await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(mockRefreshReviewCardForOrg).not.toHaveBeenCalled();
  });

  it('passes the admin actor shape to markLinkedInPosted', async () => {
    mockMarkLinkedInPosted.mockResolvedValueOnce({ kind: 'recorded', draft: {}, state: {} });
    const app = await buildApp();
    await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(mockMarkLinkedInPosted).toHaveBeenCalledWith(ORG_ID, {
      source: 'admin',
      workosUserId: 'user_wk_admin01',
    });
  });

  it('returns 500 when markLinkedInPosted throws', async () => {
    mockMarkLinkedInPosted.mockRejectedValueOnce(new Error('db down'));
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/admin/accounts/${ORG_ID}/announcement/linkedin`)
      .send({});
    expect(res.status).toBe(500);
  });
});
