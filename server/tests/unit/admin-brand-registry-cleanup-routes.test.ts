/**
 * Route guards for the enrichment cleanup (adcp#9024). The selection and
 * delete safety are exercised against Postgres in
 * tests/integration/brand-enrichment-cleanup.test.ts; this pins the request
 * contract: dry run by default, explicit confirm, human admin to delete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  apply: vi.fn(),
}));

let currentUser: Record<string, unknown> | null = { id: 'user_admin', email: 'admin@test.example' };
let isAdmin = true;
let isStaticAdminApiKey = false;

vi.mock('../../src/middleware/auth.js', () => ({
  requireGlobalAdmin: [
    (req: any, res: any, next: () => void) => {
      if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
      req.user = currentUser;
      if (isStaticAdminApiKey) req.isStaticAdminApiKey = true;
      next();
    },
    (_req: any, res: any, next: () => void) => {
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      next();
    },
  ],
}));

vi.mock('../../src/services/enrichment-cleanup.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/enrichment-cleanup.js')>(
    '../../src/services/enrichment-cleanup.js',
  );
  return {
    ...actual,
    previewEnrichmentCleanup: mocks.preview,
    applyEnrichmentCleanup: mocks.apply,
  };
});

import { setupBrandRegistryCleanupRoutes } from '../../src/routes/admin/brand-registry-cleanup.js';

const URL = '/api/admin/brand-registry/enrichment-cleanup';

function makeApp() {
  const app = express();
  app.use(express.json());
  const apiRouter = express.Router();
  setupBrandRegistryCleanupRoutes(apiRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

describe('POST /api/admin/brand-registry/enrichment-cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: 'user_admin', email: 'admin@test.example' };
    isAdmin = true;
    isStaticAdminApiKey = false;
    mocks.preview.mockResolvedValue({ mode: 'criteria', candidates: [], skipped: [], total_candidates: 0, truncated: false, max_batch: 200 });
    mocks.apply.mockResolvedValue({ mode: 'criteria', deleted: [], skipped: [], failed: [], remaining: 0, max_batch: 200 });
  });

  it('is admin-only', async () => {
    isAdmin = false;
    const res = await request(makeApp()).post(URL).send({});
    expect(res.status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('runs a dry run by default', async () => {
    const res = await request(makeApp()).post(URL).send({});
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(mocks.preview).toHaveBeenCalledWith({ domains: undefined });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('lets an API key run a dry run', async () => {
    isStaticAdminApiKey = true;
    const res = await request(makeApp()).post(URL).send({ domains: ['A.Example.com '] });
    expect(res.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith({ domains: ['a.example.com'] });
  });

  it('does not delete without confirm', async () => {
    const res = await request(makeApp()).post(URL).send({ dry_run: false });
    expect(res.status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('does not delete with an API key', async () => {
    isStaticAdminApiKey = true;
    const res = await request(makeApp()).post(URL).send({ dry_run: false, confirm: true });
    expect(res.status).toBe(403);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('deletes as the signed-in admin when confirmed', async () => {
    const res = await request(makeApp()).post(URL).send({ dry_run: false, confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(false);
    expect(mocks.apply).toHaveBeenCalledWith({
      domains: undefined,
      actorUserId: 'user_admin',
      actorEmail: 'admin@test.example',
    });
  });

  it('rejects a malformed or oversized domain list', async () => {
    expect((await request(makeApp()).post(URL).send({ domains: 'a.com' })).status).toBe(400);
    expect((await request(makeApp()).post(URL).send({ domains: [] })).status).toBe(400);
    expect((await request(makeApp()).post(URL).send({ domains: [42] })).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => `d${i}.acme.com`);
    expect((await request(makeApp()).post(URL).send({ domains: tooMany })).status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
