import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const effects = vi.hoisted(() => ({
  auth: vi.fn(() => { throw new Error('Authentication must not hydrate a contained deletion'); }),
  admin: vi.fn(() => { throw new Error('Admin resolution must not run'); }),
  database: vi.fn(() => { throw new Error('Database must not be accessed'); }),
  provider: vi.fn(() => { throw new Error('Provider must not be accessed'); }),
}));
vi.mock('@workos-inc/node', () => ({ WorkOS: class {
  organizations = { deleteOrganization: effects.provider };
  userManagement = { listOrganizationMemberships: effects.provider };
} }));
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: effects.auth, requireAdmin: effects.admin,
}));
vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: effects.database, query: effects.database,
}));
vi.mock('../../src/auth/workos-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-client.js')>()),
  getAuthorizationObserverWorkos: effects.provider,
}));

import { createOrganizationsRouter } from '../../src/routes/organizations.js';
import { setupAccountsBillingRoutes } from '../../src/routes/admin/accounts-billing.js';
import { observeLinkedCredentialOrganizationAuthorization } from '../../src/middleware/organization-authorization-observer.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';

function app(providerPresent: boolean) {
  const app = express();
  app.use(express.json());
  // A prehydrated linked principal must not trigger the finish observer either.
  app.use((req, res, next) => {
    req.user = { id: 'user_b', authWorkosUserId: 'user_a' } as express.Request['user'];
    res.on('finish', () => { void observeLinkedCredentialOrganizationAuthorization(req, `DELETE ${req.path}`, res.statusCode); });
    next();
  });
  app.use('/api/organizations', createOrganizationsRouter());
  const admin = express.Router();
  setupAccountsBillingRoutes(admin, { workos: providerPresent ? { organizations: { deleteOrganization: effects.provider } } as any : null });
  app.use('/api/admin', admin);
  return app;
}

beforeEach(() => { vi.clearAllMocks(); });
afterAll(() => { stopAuthTimers(); });
describe('organization deletion unconditional unavailable contract', () => {
  for (const providerPresent of [true,false]) {
    for (const path of ['/api/organizations/org_a','/api/admin/accounts/org_a']) {
      for (const body of [undefined, {}, { confirmation: 'Pinnacle Agency', force: true, organization_id: 'org_b' }]) {
        it(`${path}: provider=${providerPresent}, body=${JSON.stringify(body)} refuses before any collaborator`, async () => {
          const response = await request(app(providerPresent)).delete(`${path}?org=org_b&org=org_c`)
            .set('X-Organization-Id','org_b').set('Authorization','Bearer arbitrary').send(body);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(response.status).toBe(503);
          expect(response.body).toEqual({ error: 'organization_deletion_unavailable', message: 'Organization deletion is temporarily unavailable.' });
          for (const spy of Object.values(effects)) expect(spy).not.toHaveBeenCalled();
        });
      }
    }
  }
});
