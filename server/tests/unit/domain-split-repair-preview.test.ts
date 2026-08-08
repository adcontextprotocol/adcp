import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomainRoutes } from '../../src/routes/admin/domains.js';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: () => ({ query: queryMock }),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireGlobalAdmin: [
    (_req: Request, _res: Response, next: NextFunction) => next(),
    (_req: Request, _res: Response, next: NextFunction) => next(),
  ],
}));

function app() {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  setupDomainRoutes(router, { workos: null });
  app.use('/api/admin', router);
  return app;
}

function mockPreviewQueries(orgRows: Array<{ workos_organization_id: string; name: string; is_personal: boolean }>) {
  queryMock
    .mockResolvedValueOnce({ rows: orgRows })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

describe('domain split repair preview', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('rejects identical company and personal org ids', async () => {
    const res = await request(app())
      .post('/api/admin/domain-split-repair/preview')
      .send({
        domain: 'example.com',
        company_org_id: 'org_same',
        personal_org_id: 'org_same',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('company_and_personal_org_must_differ');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a company org that is marked personal', async () => {
    mockPreviewQueries([
      { workos_organization_id: 'org_personal', name: 'Personal', is_personal: true },
    ]);

    const res = await request(app())
      .post('/api/admin/domain-split-repair/preview')
      .send({
        domain: 'example.com',
        company_org_id: 'org_personal',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('company_org_is_personal');
  });

  it('rejects a personal org that is not marked personal', async () => {
    mockPreviewQueries([
      { workos_organization_id: 'org_company', name: 'Company', is_personal: false },
      { workos_organization_id: 'org_other_company', name: 'Other Company', is_personal: false },
    ]);

    const res = await request(app())
      .post('/api/admin/domain-split-repair/preview')
      .send({
        domain: 'example.com',
        company_org_id: 'org_company',
        personal_org_id: 'org_other_company',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('personal_org_is_not_personal');
  });
});
