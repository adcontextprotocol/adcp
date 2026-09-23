import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Pins the ORDERING claim the route comment and the containment document make:
 * `POST /api/admin/cleanup/merge` refuses on its own, before the merge service.
 *
 * Its sibling suite (organization-merge-containment.test.ts) spreads the real
 * org-merge-db module so the genuine contained `mergeOrganizations` is under
 * test. That proves the service refuses, but it cannot distinguish "the route
 * refuses first" from "the route calls the service and maps its throw to 503" —
 * both produce a 503 and no effects. This file mocks the service with a throwing
 * spy so that difference is observable.
 */
const effects = vi.hoisted(() => ({
  mergeOrganizations: vi.fn(() => { throw new Error('The route must not reach the merge service'); }),
  previewMerge: vi.fn(() => { throw new Error('The contained route must not preview'); }),
  getPool: vi.fn(() => { throw new Error('The contained route must not touch the database pool'); }),
  globalAdminGate: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
}));

vi.mock('../../src/db/org-merge-db.js', () => ({
  mergeOrganizations: effects.mergeOrganizations,
  previewMerge: effects.previewMerge,
}));
vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: effects.getPool,
}));
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireGlobalAdmin: [effects.globalAdminGate],
}));

import { setupCleanupRoutes } from '../../src/routes/admin/cleanup.js';
import {
  ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
  ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
} from '../../src/db/org-merge-containment.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';

function cleanupApp() {
  const app = express();
  app.use(express.json());
  const apiRouter = express.Router();
  setupCleanupRoutes(apiRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

beforeEach(() => { vi.clearAllMocks(); });
afterAll(() => { stopAuthTimers(); });

describe('POST /api/admin/cleanup/merge refuses before the merge service', () => {
  for (const body of [
    {},
    { primary_org_id: 'org_a', secondary_org_id: 'org_b' },
    { primary_org_id: 'org_a', secondary_org_id: 'org_b', stripe_customer_resolution: 'keep_primary' },
  ]) {
    it(`never calls mergeOrganizations for ${JSON.stringify(body)}`, async () => {
      const response = await request(cleanupApp()).post('/api/admin/cleanup/merge').send(body);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
        message: ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
      });
      // The discriminating assertion: a route that delegated and mapped the
      // service's throw would have called this spy.
      expect(effects.mergeOrganizations).not.toHaveBeenCalled();
      expect(effects.previewMerge).not.toHaveBeenCalled();
      expect(effects.getPool).not.toHaveBeenCalled();
    });
  }

  it('proves the spy is wired, so "not called" is meaningful', async () => {
    // Positive control: the same mocked module is what the route file imports,
    // and calling through it does reach the spy.
    const { mergeOrganizations } = await import('../../src/db/org-merge-db.js');
    expect(() => mergeOrganizations('org_a', 'org_b', 'user_a')).toThrow(
      'The route must not reach the merge service',
    );
    expect(effects.mergeOrganizations).toHaveBeenCalledTimes(1);
  });
});
