import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// `getPool`, `query` and `previewMerge` are the discriminating doubles here:
// the real contained mergeOrganizations and the contained route would reach
// them if either stopped refusing. The three provider methods are tripwires
// rather than discriminators — they hang off the `providerDouble` passed as the
// ignored `_workos` argument, so they only fire if a future edit starts using
// it. `getWorkos` is deliberately NOT asserted in this file: nothing in its
// import graph can call it (cleanup.ts no longer imports it). That property is
// covered where it is observable, in
// organization-merge-containment-addie.test.ts.
const effects = vi.hoisted(() => ({
  getPool: vi.fn(() => { throw new Error('Contained merge must not touch the database pool'); }),
  query: vi.fn(() => { throw new Error('Contained merge must not query the database'); }),
  deleteOrganization: vi.fn(() => { throw new Error('Contained merge must not delete a provider organization'); }),
  createOrganizationMembership: vi.fn(() => { throw new Error('Contained merge must not write provider memberships'); }),
  listOrganizationMemberships: vi.fn(() => { throw new Error('Contained merge execution must not read provider memberships'); }),
  previewMerge: vi.fn(),
  globalAdminGate: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
}));

vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: effects.getPool,
  query: effects.query,
}));
// Spread the original so `mergeOrganizations` under test is the real contained
// implementation; only the read-only preview is swapped for an observable double.
vi.mock('../../src/db/org-merge-db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/org-merge-db.js')>()),
  previewMerge: effects.previewMerge,
}));
vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireGlobalAdmin: [effects.globalAdminGate],
}));

import { mergeOrganizations } from '../../src/db/org-merge-db.js';
import {
  ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
  ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
  OrganizationMergeUnavailableError,
} from '../../src/db/org-merge-containment.js';
import { setupCleanupRoutes } from '../../src/routes/admin/cleanup.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';
import type { WorkOS } from '@workos-inc/node';

const unavailable = {
  error: ORGANIZATION_MERGE_UNAVAILABLE_ERROR,
  message: ORGANIZATION_MERGE_UNAVAILABLE_MESSAGE,
};
const PRIMARY = 'org_merge_contained_primary';
const SECONDARY = 'org_merge_contained_secondary';

// A provider double whose every method throws. Passing it into the contained
// service proves the refusal happens before the client is ever used.
const providerDouble = {
  organizations: { deleteOrganization: effects.deleteOrganization },
  userManagement: {
    createOrganizationMembership: effects.createOrganizationMembership,
    listOrganizationMemberships: effects.listOrganizationMemberships,
  },
} as unknown as WorkOS;

function cleanupApp() {
  const app = express();
  app.use(express.json());
  const apiRouter = express.Router();
  setupCleanupRoutes(apiRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

function expectNoEffects() {
  for (const [name, spy] of Object.entries(effects)) {
    if (name === 'globalAdminGate') continue;
    expect(spy, `${name} must not be called`).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  effects.globalAdminGate.mockImplementation((_req, _res, next) => next());
});
afterAll(() => { stopAuthTimers(); });

describe('organization merge containment — shared service boundary', () => {
  const variants: { label: string; args: Parameters<typeof mergeOrganizations> }[] = [
    { label: 'ordinary pair', args: [PRIMARY, SECONDARY, 'user_admin', providerDouble] },
    { label: 'keep_primary resolution', args: [PRIMARY, SECONDARY, 'user_admin', providerDouble, { stripeCustomerResolution: 'keep_primary' }] },
    { label: 'use_secondary resolution', args: [PRIMARY, SECONDARY, 'user_admin', providerDouble, { stripeCustomerResolution: 'use_secondary' }] },
    { label: 'keep_both_unlinked resolution', args: [PRIMARY, SECONDARY, 'user_admin', providerDouble, { stripeCustomerResolution: 'keep_both_unlinked' }] },
    { label: 'reversed direction', args: [SECONDARY, PRIMARY, 'user_admin', providerDouble] },
    { label: 'identical ids', args: [PRIMARY, PRIMARY, 'user_admin', providerDouble] },
    { label: 'unknown ids', args: [{} as unknown as string, '', '', providerDouble] },
  ];

  for (const { label, args } of variants) {
    it(`refuses a direct call (${label}) before any collaborator`, async () => {
      // Any overlooked or future caller that bypasses the route and the tool
      // still cannot execute the sequence.
      await expect(mergeOrganizations(...args)).rejects.toThrow(OrganizationMergeUnavailableError);
      expectNoEffects();
    });
  }

  it('carries the stable code and message consistent with the deletion containment', async () => {
    const error = await mergeOrganizations(PRIMARY, SECONDARY, 'user_admin', providerDouble).catch(e => e);
    expect(error).toBeInstanceOf(OrganizationMergeUnavailableError);
    expect(error.code).toBe('organization_merge_unavailable');
    expect(error.message).toBe('Organization merge is temporarily unavailable.');
    expect(error.name).toBe('OrganizationMergeUnavailableError');
    expectNoEffects();
  });

  it('refuses repeated and concurrent calls identically and still does nothing', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => mergeOrganizations(PRIMARY, SECONDARY, 'user_admin', providerDouble))
    );
    expect(outcomes.every(o => o.status === 'rejected')).toBe(true);
    for (const outcome of outcomes) {
      expect((outcome as PromiseRejectedResult).reason.code).toBe(ORGANIZATION_MERGE_UNAVAILABLE_ERROR);
    }
    expectNoEffects();
  });
});

describe('organization merge containment — POST /api/admin/cleanup/merge', () => {
  const bodies = [
    undefined,
    {},
    { primary_org_id: PRIMARY },
    { primary_org_id: PRIMARY, secondary_org_id: SECONDARY },
    { primary_org_id: PRIMARY, secondary_org_id: PRIMARY },
    { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, stripe_customer_resolution: 'keep_primary' },
    { primary_org_id: PRIMARY, secondary_org_id: SECONDARY, stripe_customer_resolution: 'not_a_resolution' },
    { primary_org_id: [PRIMARY, SECONDARY], secondary_org_id: { nested: SECONDARY }, force: true },
  ];

  for (const body of bodies) {
    it(`returns the stable unavailable response for body ${JSON.stringify(body)}`, async () => {
      const response = await request(cleanupApp()).post('/api/admin/cleanup/merge').send(body as object);
      expect(response.status).toBe(503);
      expect(response.body).toEqual(unavailable);
      // The former validation and 500 branches disclosed org state and error
      // internals; every input now gets the identical refusal.
      expect(Object.keys(response.body).sort()).toEqual(['error', 'message']);
      expectNoEffects();
    });
  }

  it('keeps administrative gating: the global admin gate still runs', async () => {
    await request(cleanupApp()).post('/api/admin/cleanup/merge').send({});
    expect(effects.globalAdminGate).toHaveBeenCalledTimes(1);
  });

  it('is unreachable when the global admin gate denies, and still has no effects', async () => {
    effects.globalAdminGate.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Authentication required' });
    });
    const response = await request(cleanupApp()).post('/api/admin/cleanup/merge').send({
      primary_org_id: PRIMARY, secondary_org_id: SECONDARY,
    });
    expect(response.status).toBe(401);
    expect(response.body.error).not.toBe(ORGANIZATION_MERGE_UNAVAILABLE_ERROR);
    expectNoEffects();
  });

  it('does not answer for neighbouring cleanup paths or other methods', async () => {
    const app = cleanupApp();
    for (const path of ['/api/admin/cleanup/merge/extra', '/api/admin/cleanup/mergex', '/api/admin/cleanup']) {
      const response = await request(app).post(path).send({});
      expect(response.status, path).toBe(404);
    }
    const wrongMethod = await request(app).delete('/api/admin/cleanup/merge').send({});
    expect(wrongMethod.status).toBe(404);
    expectNoEffects();
  });
});
