/**
 * The revision-history fix removed ownership, contact and verification
 * columns from what a non-owner can read. The sibling write routes returned
 * the same columns straight back in their response body, and their gate is
 * AAO membership rather than record ownership — so any member could read a
 * stranger's record by submitting a one-character edit.
 *
 * Same bound, same allowlists: an editor reads back what they wrote.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getClient: vi.fn(),
  user: { id: 'user_01MEMBER', email: 'member@example.com', isMember: true },
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_registry_write_projection';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_registry_write_projection';
});

vi.mock('../../src/db/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/db/client.js')>(),
  query: mocks.query,
  getClient: mocks.getClient,
  getPool: () => ({ query: mocks.query }),
  isDatabaseInitialized: () => false,
}));

vi.mock('../../src/middleware/auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  const auth: RequestHandler = (req, _res, next) => {
    req.user = mocks.user as typeof req.user;
    next();
  };
  return { ...actual, requireAuth: auth, optionalAuth: auth };
});

vi.mock('../../src/utils/html-config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils/html-config.js')>(),
  enrichUserWithMembership: vi.fn(async (user: { isMember?: boolean }) => {
    if (user) user.isMember = true;
    return user;
  }),
}));

vi.mock('../../src/notifications/registry.js', () => ({
  notifyRegistryCreate: vi.fn(async () => null),
  notifyRegistryEdit: vi.fn(async () => null),
}));

vi.mock('../../src/addie/mcp/registry-review.js', () => ({
  reviewNewRecord: vi.fn(async () => undefined),
  reviewRegistryEdit: vi.fn(async () => undefined),
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
import { BansDatabase } from '../../src/db/bans-db.js';

const server = new HTTPServer();
const registeredApp = (server as unknown as {
  app: { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } };
}).app;

const app = express();
app.use(express.json());
for (const [method, path] of [
  ['put', '/api/properties/hosted/:domain'],
  ['put', '/api/brands/discovered/:domain'],
] as const) {
  const route = registeredApp.router.stack.find(l => l.route?.path === path && l.route.methods[method])?.route;
  if (!route) throw new Error(`Missing registered route: ${method} ${path}`);
  app[method](path, ...route.stack.map(l => l.handle));
}

/** Another organization's record, as the edit path returns it. */
const PROPERTY_ROW = {
  id: 'prop_01',
  publisher_domain: 'victimcorp.io',
  adagents_json: { authorized_agents: [] },
  source_type: 'community',
  review_status: 'approved',
  claim_token: 'claim_tok_live',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01VICTIM',
  claimant_org_id: 'org_01CLAIMANT',
  created_by_user_id: 'user_01VICTIM',
  created_by_email: 'victim@example.com',
};

const BRAND_ROW = {
  id: 'brand_01',
  domain: 'victimcorp.io',
  brand_name: 'Victim Corp',
  brand_manifest: { name: 'Victim Corp' },
  source_type: 'community',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01VICTIM',
  prior_owner_org_id: 'org_01PRIOR',
  created_by_user_id: 'user_01VICTIM',
  created_by_email: 'victim@example.com',
};

const LEAKS = [
  'claim_tok_live', 'verify_tok_live', 'org_01VICTIM',
  'org_01CLAIMANT', 'org_01PRIOR', 'user_01VICTIM', 'victim@example.com',
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(BansDatabase.prototype, 'isUserBannedFromRegistry').mockResolvedValue({ banned: false } as never);
  vi.spyOn(PropertyDatabase.prototype, 'editCommunityProperty')
    .mockResolvedValue({ property: PROPERTY_ROW, revision_number: 2 } as never);
  vi.spyOn(PropertyDatabase.prototype, 'getPropertyRevision').mockResolvedValue(null as never);
  vi.spyOn(BrandDatabase.prototype, 'editDiscoveredBrand')
    .mockResolvedValue({ brand: BRAND_ROW, revision_number: 2 } as never);
  vi.spyOn(BrandDatabase.prototype, 'getBrandRevision').mockResolvedValue(null as never);
});

afterAll(() => server.stop());

describe('PUT /api/properties/hosted/:domain', () => {
  it('returns the edit without the record owner\'s credentials or contact details', async () => {
    const res = await request(app)
      .put('/api/properties/hosted/victimcorp.io')
      .send({ edit_summary: 'x', adagents_json: { authorized_agents: [] } });

    expect(res.status).toBe(200);
    expect(res.body.revision_number).toBe(2);
    expect(res.body.property).toMatchObject({ publisher_domain: 'victimcorp.io' });
    for (const leak of LEAKS) expect(JSON.stringify(res.body)).not.toContain(leak);
  });
});

describe('PUT /api/brands/discovered/:domain', () => {
  it('returns the edit without the record owner\'s credentials or contact details', async () => {
    const res = await request(app)
      .put('/api/brands/discovered/victimcorp.io')
      .send({ edit_summary: 'x', brand_name: 'Victim Corp' });

    expect(res.status).toBe(200);
    expect(res.body.revision_number).toBe(2);
    expect(res.body.brand).toMatchObject({ domain: 'victimcorp.io' });
    for (const leak of LEAKS) expect(JSON.stringify(res.body)).not.toContain(leak);
  });
});
