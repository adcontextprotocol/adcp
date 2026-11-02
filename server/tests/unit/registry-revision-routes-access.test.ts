import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
  isAdmin: vi.fn().mockResolvedValue(false),
  resolveUserOrgAuthorization: vi.fn(),
  /** Set per test; `null` means the request arrives with no credential. */
  user: null as { id: string; email: string } | null,
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_registry_revision_access';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_registry_revision_access';
});

vi.mock('../../src/db/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/db/client.js')>(),
  query: mocks.query,
  getClient: mocks.getClient,
  getPool: () => ({ query: mocks.query }),
  isDatabaseInitialized: () => false,
}));

// Stands in for the real middleware: a request with no credential is refused
// before the handler runs, a request with one carries its user through.
vi.mock('../../src/middleware/auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!mocks.user) return res.status(401).json({ error: 'Authentication required' });
    req.user = mocks.user as typeof req.user;
    next();
  };
  const optionalAuth: RequestHandler = (req, _res, next) => {
    if (mocks.user) req.user = mocks.user as typeof req.user;
    next();
  };
  return { ...actual, requireAuth, optionalAuth };
});

vi.mock('../../src/utils/resolve-user-org-authorization.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils/resolve-user-org-authorization.js')>(),
  resolveUserOrgAuthorization: mocks.resolveUserOrgAuthorization,
}));

vi.mock('../../src/addie/admin-status-lookup.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/addie/admin-status-lookup.js')>(),
  isAuthenticatedUserAAOAdmin: mocks.isAdmin,
}));

vi.mock('../../src/middleware/csrf.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/middleware/csrf.js')>(),
  csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/routes/addie-chat.js', async () => {
  const { Router } = await import('express');
  return {
    createAddieChatRouter: () => ({ pageRouter: Router(), apiRouter: Router() }),
    isWebChatReady: () => false,
  };
});

import { HTTPServer } from '../../src/http.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import { BrandDatabase } from '../../src/db/brand-db.js';

const server = new HTTPServer();
const registeredApp = (server as unknown as {
  app: { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } };
}).app;

const PROPERTY_LIST = '/api/properties/hosted/:domain/revisions';
const PROPERTY_ONE = '/api/properties/hosted/:domain/revisions/:num';
const BRAND_LIST = '/api/brands/discovered/:domain/revisions';
const BRAND_ONE = '/api/brands/discovered/:domain/revisions/:num';

// Lift the registered handlers out of the real server rather than
// re-declaring them, so the test cannot drift from the routes it covers.
// Same approach as `property-ingress-validation.test.ts`; the route lookup
// throws loudly if Express's stack shape or a path ever changes.
const app = express();
app.use(express.json());
for (const path of [PROPERTY_LIST, PROPERTY_ONE, BRAND_LIST, BRAND_ONE]) {
  const route = registeredApp.router.stack.find(layer => layer.route?.path === path && layer.route.methods.get)?.route;
  if (!route) throw new Error(`Missing registered route: ${path}`);
  // Mount the whole stack, so the route's own auth middleware is exercised.
  app.get(path, ...route.stack.map(layer => layer.handle));
}

/** A stored snapshot written before the allowlist existed. */
const LEGACY_PROPERTY_SNAPSHOT = {
  publisher_domain: 'news.example',
  adagents_json: { authorized_agents: [] },
  claim_token: 'claim_tok_live',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01OWNER',
  claimant_org_id: 'org_01CLAIMANT',
  created_by_user_id: 'user_01CREATOR',
  created_by_email: 'owner@example.com',
};

const LEGACY_BRAND_SNAPSHOT = {
  domain: 'acme.example',
  brand_name: 'Acme',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01OWNER',
  created_by_email: 'owner@example.com',
};

/**
 * A stored `*_revisions` row exactly as the table holds it. The revision
 * getters run for real against these so the database layer's own read-side
 * sanitizer is part of what the route tests cover.
 */
function storedRow(domainColumn: string, domain: string, snapshot: Record<string, unknown>) {
  return {
    id: 'rev_01',
    [domainColumn]: domain,
    revision_number: 2,
    snapshot,
    editor_user_id: 'user_01EDITOR',
    editor_email: 'editor@example.com',
    editor_name: 'Sam Adeyemi',
    edit_summary: 'Added an authorized agent',
    is_rollback: false,
    created_at: new Date('2026-03-01T00:00:00.000Z'),
  };
}

/** Overridable per test, so a stored row can be reshaped without re-mocking. */
let propertyRow: Record<string, unknown>;
let brandRow: Record<string, unknown>;

const getHostedProperty = vi.spyOn(PropertyDatabase.prototype, 'getHostedPropertyByDomain');
const getDiscoveredBrand = vi.spyOn(BrandDatabase.prototype, 'getDiscoveredBrandByDomain');

beforeEach(() => {
  mocks.user = null;
  propertyRow = storedRow('publisher_domain', 'news.example', LEGACY_PROPERTY_SNAPSHOT);
  brandRow = storedRow('brand_domain', 'acme.example', LEGACY_BRAND_SNAPSHOT);
  mocks.isAdmin.mockReset().mockResolvedValue(false);
  mocks.resolveUserOrgAuthorization.mockReset()
    .mockResolvedValue({ status: 'forbidden', complete: true, unavailableSources: [] });
  mocks.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }], rowCount: 1 };
    if (sql.includes('property_revisions')) return { rows: [propertyRow], rowCount: 1 };
    if (sql.includes('brand_revisions')) return { rows: [brandRow], rowCount: 1 };
    throw new Error(`Unexpected query in test: ${sql}`);
  });
  getHostedProperty.mockResolvedValue({
    workos_organization_id: 'org_01OWNER',
    created_by_user_id: 'user_01CREATOR',
  } as never);
  getDiscoveredBrand.mockResolvedValue({
    workos_organization_id: 'org_01OWNER',
    created_by_user_id: 'user_01CREATOR',
  } as never);
});

afterAll(() => server.stop());

describe.each([
  { label: 'property', domain: 'news.example', list: '/api/properties/hosted/news.example/revisions', one: '/api/properties/hosted/news.example/revisions/2' },
  { label: 'brand', domain: 'acme.example', list: '/api/brands/discovered/acme.example/revisions', one: '/api/brands/discovered/acme.example/revisions/2' },
])('$label revision history', ({ label, domain, list, one }) => {
  describe('public changelog', () => {
    it('serves the changelog without the stored snapshot or editor contact details', async () => {
      const res = await request(app).get(list);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.revisions).toEqual([{
        id: 'rev_01',
        domain,
        revision_number: 2,
        edit_summary: 'Added an authorized agent',
        editor_name: 'Sam Adeyemi',
        is_rollback: false,
        created_at: '2026-03-01T00:00:00.000Z',
      }]);
      const body = JSON.stringify(res.body);
      for (const leak of ['claim_tok_live', 'verify_tok_live', 'org_01OWNER', 'org_01CLAIMANT', 'user_01CREATOR', 'owner@example.com', 'editor@example.com', 'user_01EDITOR']) {
        expect(body).not.toContain(leak);
      }
    });

    it('caps the edit summary it publishes', async () => {
      const long = 'x'.repeat(5_000);
      propertyRow = { ...propertyRow, edit_summary: long };
      brandRow = { ...brandRow, edit_summary: long };
      const res = await request(app).get(list);
      expect(res.status).toBe(200);
      expect(res.body.revisions[0].edit_summary).toHaveLength(1_000);
    });

    it('does not publish an editor name that is an email address', async () => {
      propertyRow = { ...propertyRow, editor_name: 'editor@example.com' };
      brandRow = { ...brandRow, editor_name: 'editor@example.com' };
      const res = await request(app).get(list);
      expect(res.status).toBe(200);
      expect(res.body.revisions[0]).not.toHaveProperty('editor_name');
      expect(JSON.stringify(res.body)).not.toContain('editor@example.com');
    });
  });

  describe('single revision', () => {
    it('rejects an unauthenticated caller', async () => {
      const res = await request(app).get(one);
      expect(res.status).toBe(401);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('rejects an authenticated caller who neither owns the record nor is an admin', async () => {
      mocks.user = { id: 'user_01STRANGER', email: 'stranger@example.com' };
      const res = await request(app).get(one);
      expect(res.status).toBe(403);
      expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining(`${label}_revisions`), expect.anything());
    });

    it('serves the record creator a snapshot with no credential, org id or contact field', async () => {
      mocks.user = { id: 'user_01CREATOR', email: 'owner@example.com' };
      const res = await request(app).get(one);
      expect(res.status).toBe(200);
      expect(res.body.snapshot).toBeTruthy();
      const body = JSON.stringify(res.body);
      for (const leak of ['claim_tok_live', 'verify_tok_live', 'org_01OWNER', 'org_01CLAIMANT', 'user_01CREATOR', 'owner@example.com']) {
        expect(body).not.toContain(leak);
      }
    });

    it('serves a member of the owning organization', async () => {
      mocks.user = { id: 'user_01COLLEAGUE', email: 'colleague@example.com' };
      mocks.resolveUserOrgAuthorization.mockResolvedValue({
        status: 'authorized',
        membership: { organizationId: 'org_01OWNER', role: 'member', source: 'workos' },
        complete: true,
        unavailableSources: [],
      });
      expect((await request(app).get(one)).status).toBe(200);
      expect(mocks.resolveUserOrgAuthorization).toHaveBeenCalledWith(
        expect.anything(), expect.objectContaining({ id: 'user_01COLLEAGUE' }), 'org_01OWNER',
      );
    });

    it('reports an authorization outage as unavailable rather than denied', async () => {
      mocks.user = { id: 'user_01COLLEAGUE', email: 'colleague@example.com' };
      mocks.resolveUserOrgAuthorization.mockResolvedValue({
        status: 'unavailable', complete: false, unavailableSources: ['workos'],
      });
      const res = await request(app).get(one);
      expect(res.status).toBe(503);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('serves an AAO admin', async () => {
      mocks.user = { id: 'user_01ADMIN', email: 'admin@example.com' };
      mocks.isAdmin.mockResolvedValue(true);
      expect((await request(app).get(one)).status).toBe(200);
    });

    it('leaves a deleted record\'s surviving history to admins only', async () => {
      // A malicious-verdict cleanup deletes the record and leaves the
      // revisions behind, so there is no owner left to check against.
      getHostedProperty.mockResolvedValue(null as never);
      getDiscoveredBrand.mockResolvedValue(null as never);

      mocks.user = { id: 'user_01CREATOR', email: 'owner@example.com' };
      expect((await request(app).get(one)).status).toBe(403);
      expect(mocks.resolveUserOrgAuthorization).not.toHaveBeenCalled();

      mocks.isAdmin.mockResolvedValue(true);
      expect((await request(app).get(one)).status).toBe(200);
    });
  });
});
