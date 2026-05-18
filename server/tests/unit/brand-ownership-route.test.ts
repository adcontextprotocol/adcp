/**
 * Unit tests for GET /api/brands/:domain/ownership (#4741).
 *
 * Pinned scenarios: community (no row + row-with-no-owner), verified (with and
 * without same-org caller), orphaned, and malformed domain. DB and org lookups
 * are mocked — the integration test (when DB is available) covers wire shape;
 * this file pins the response logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/middleware/auth.js', async () => ({
  optionalAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    if (currentUserId !== null) {
      req.user = { id: currentUserId, email: `${currentUserId}@test.com` };
    }
    next();
  },
}));

const resolvePrimaryOrganizationMock = vi.fn();
vi.mock('../../src/db/users-db.js', () => ({
  resolvePrimaryOrganization: (userId: string) => resolvePrimaryOrganizationMock(userId),
}));

import { createBrandOwnershipRouter } from '../../src/routes/brand-ownership.js';
import type { BrandDatabase } from '../../src/db/brand-db.js';
import type { OrganizationDatabase } from '../../src/db/organization-db.js';

let currentUserId: string | null = null;

const OWNER_ORG = 'org_owner';
const OWNER_USER = 'user_owner';
const OTHER_USER = 'user_other';

function makeApp(brandRow: Record<string, unknown> | null, orgName: string | null) {
  const brandDb = {
    getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(brandRow),
  } as unknown as BrandDatabase;
  const orgDb = {
    getOrganization: vi.fn().mockResolvedValue(orgName ? { name: orgName } : null),
  } as unknown as OrganizationDatabase;
  const app = express();
  app.use('/api', createBrandOwnershipRouter({ brandDb, orgDb }));
  return app;
}

describe('GET /api/brands/:domain/ownership', () => {
  beforeEach(() => {
    currentUserId = null;
    resolvePrimaryOrganizationMock.mockReset();
  });

  it('treats a missing brand row as community (not 404)', async () => {
    const app = makeApp(null, null);
    const res = await request(app).get('/api/brands/example.com/ownership');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      domain: 'example.com',
      status: 'community',
      owner: null,
      can_claim: false,
      can_manage: false,
      authenticated: false,
    });
  });

  it('returns community when the brand row exists but is unclaimed', async () => {
    const app = makeApp({ domain: 'example.com' }, null);
    const res = await request(app).get('/api/brands/example.com/ownership');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('community');
    expect(res.body.owner).toBeNull();
  });

  it('returns verified + owner name for a claimed brand', async () => {
    const app = makeApp(
      { domain: 'example.com', workos_organization_id: OWNER_ORG, domain_verified: true },
      'Acme Corp',
    );
    const res = await request(app).get('/api/brands/example.com/ownership');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');
    expect(res.body.owner).toEqual({ name: 'Acme Corp' });
    expect(res.body.can_manage).toBe(false);
    expect(res.body.can_claim).toBe(false);
  });

  it('sets can_manage when the authenticated user belongs to the owning org', async () => {
    const app = makeApp(
      { domain: 'example.com', workos_organization_id: OWNER_ORG, domain_verified: true },
      'Acme Corp',
    );
    currentUserId = OWNER_USER;
    resolvePrimaryOrganizationMock.mockResolvedValueOnce(OWNER_ORG);
    const res = await request(app).get('/api/brands/example.com/ownership');
    expect(res.status).toBe(200);
    expect(res.body.can_manage).toBe(true);
    expect(res.body.can_claim).toBe(false);
    expect(res.body.manage_url).toBe('/brand/builder?domain=example.com');
    expect(res.body.claim_url).toBeNull();
  });

  it('does not let an unrelated authenticated user claim a verified brand', async () => {
    const app = makeApp(
      { domain: 'example.com', workos_organization_id: OWNER_ORG, domain_verified: true },
      'Acme Corp',
    );
    currentUserId = OTHER_USER;
    resolvePrimaryOrganizationMock.mockResolvedValueOnce('org_other');
    const res = await request(app).get('/api/brands/example.com/ownership');
    expect(res.status).toBe(200);
    expect(res.body.can_manage).toBe(false);
    expect(res.body.can_claim).toBe(false);
  });

  it('lets any authenticated user claim a community brand', async () => {
    const app = makeApp({ domain: 'example.com' }, null);
    currentUserId = OTHER_USER;
    resolvePrimaryOrganizationMock.mockResolvedValueOnce('org_other');
    const res = await request(app).get('/api/brands/example.com/ownership');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('community');
    expect(res.body.can_claim).toBe(true);
    expect(res.body.claim_url).toBe('/brand/builder?domain=example.com');
  });

  it('reports orphaned status without leaking prior owner', async () => {
    const app = makeApp(
      { domain: 'example.com', manifest_orphaned: true, prior_owner_org_id: OWNER_ORG },
      null,
    );
    currentUserId = OTHER_USER;
    resolvePrimaryOrganizationMock.mockResolvedValueOnce('org_other');
    const res = await request(app).get('/api/brands/example.com/ownership');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('orphaned');
    expect(res.body.owner).toBeNull();
    expect(res.body.can_claim).toBe(true);
  });

  it('rejects malformed domains', async () => {
    const app = makeApp(null, null);
    const res = await request(app).get('/api/brands/not_a_domain/ownership');
    expect(res.status).toBe(400);
  });

  it('canonicalizes the domain (strips www, lowercases) before lookup', async () => {
    const getBrand = vi.fn().mockResolvedValue(null);
    const brandDb = { getDiscoveredBrandByDomain: getBrand } as unknown as BrandDatabase;
    const orgDb = { getOrganization: vi.fn() } as unknown as OrganizationDatabase;
    const app = express();
    app.use('/api', createBrandOwnershipRouter({ brandDb, orgDb }));
    const res = await request(app).get('/api/brands/WWW.Example.COM/ownership');
    expect(res.status).toBe(200);
    expect(getBrand).toHaveBeenCalledWith('example.com');
    expect(res.body.domain).toBe('example.com');
  });
});
