import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getClient: vi.fn(),
  enhanceProperty: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_property_ingress';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_property_ingress';
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
  const auth: import('express').RequestHandler = (req, _res, next) => {
    req.user = { id: 'test_user', email: 'buyer@pinnacle.example', isMember: true } as typeof req.user;
    next();
  };
  return { ...actual, requireAuth: auth, optionalAuth: auth };
});

vi.mock('../../src/middleware/csrf.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/middleware/csrf.js')>(),
  csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/utils/html-config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils/html-config.js')>(),
  enrichUserWithMembership: vi.fn(),
}));

vi.mock('../../src/services/property-enhancement.js', () => ({ enhanceProperty: mocks.enhanceProperty }));
vi.mock('../../src/routes/addie-chat.js', async () => {
  const { Router } = await import('express');
  return {
    createAddieChatRouter: () => ({ pageRouter: Router(), apiRouter: Router() }),
    isWebChatReady: () => false,
  };
});

import { HTTPServer } from '../../src/http.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import { CatalogDatabase } from '../../src/db/catalog-db.js';
import { createPropertyToolHandlers } from '../../src/addie/mcp/property-tools.js';
import { MCPToolHandler } from '../../src/mcp-tools.js';

const server = new HTTPServer();
const registeredApp = (server as unknown as {
  app: { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } };
}).app;
// Exercise the registered handlers without unrelated app-wide auth, telemetry,
// and router middleware. Membership and database access are mocked above.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 'test_user', email: 'buyer@pinnacle.example', isMember: true } as typeof req.user;
  next();
});
for (const [method, path] of [
  ['post', '/api/properties/hosted'],
  ['post', '/api/properties/hosted/community'],
  ['put', '/api/properties/hosted/:domain'],
] as const) {
  const route = registeredApp.router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])?.route;
  if (!route) throw new Error(`Missing registered route: ${path}`);
  app[method](path, route.stack.at(-1)!.handle);
}
const addieHandlers = createPropertyToolHandlers();
const catalogResolve = vi.spyOn(CatalogDatabase.prototype, 'resolveIdentifiers');
const hostedLookup = vi.spyOn(PropertyDatabase.prototype, 'getHostedPropertyByDomain');
const createHosted = vi.spyOn(PropertyDatabase.prototype, 'createHostedProperty');
const createCommunity = vi.spyOn(PropertyDatabase.prototype, 'createCommunityProperty');
const editCommunity = vi.spyOn(PropertyDatabase.prototype, 'editCommunityProperty');

beforeEach(() => vi.clearAllMocks());
afterAll(() => server.stop());

const invalidDomains = [
  'publisher.example', 'publisher.test', 'example.com', 'https://publisher.com/path',
  'publisher.com:443', 'publisher.com ', 'publisher.com\n', 'Publisher.com',
  '*.publisher.com', '127.0.0.1', 123, {}, null,
];

function expectNoPropertyAccess() {
  expect(hostedLookup).not.toHaveBeenCalled();
  expect(createHosted).not.toHaveBeenCalled();
  expect(createCommunity).not.toHaveBeenCalled();
  expect(editCommunity).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.getClient).not.toHaveBeenCalled();
}

describe('HTTP hosted-property write ingress', () => {
  it.each(['/api/properties/hosted', '/api/properties/hosted/community'])(
    'rejects malformed and reserved domains before storage at %s', async path => {
      for (const publisher_domain of invalidDomains) {
        const response = await request(app).post(path).send({
          publisher_domain, adagents_json: { authorized_agents: [] },
        });
        expect(response.status, String(publisher_domain)).toBe(400);
      }
      expectNoPropertyAccess();
    },
  );

  it('rejects reserved and malformed edit domains before storage', async () => {
    for (const domain of ['publisher.example', 'Publisher.com', 'publisher.com ', 'https://publisher.com/path']) {
      const response = await request(app)
        .put(`/api/properties/hosted/${encodeURIComponent(domain)}`)
        .send({ edit_summary: 'Update inventory', adagents_json: { authorized_agents: [] } });
      expect(response.status, domain).toBe(400);
    }
    expectNoPropertyAccess();
  });
});

describe('Addie and directory MCP property write ingress', () => {
  it('rejects invalid Addie saves before any property lookup or mutation', async () => {
    for (const publisher_domain of invalidDomains) {
      const result = JSON.parse(await addieHandlers.get('save_property')!({ publisher_domain }));
      expect(result.error, String(publisher_domain)).toMatch(/publisher_domain/);
    }
    expectNoPropertyAccess();
  });

  it('rejects invalid directory MCP saves before any property lookup or mutation', async () => {
    const handler = new MCPToolHandler();
    for (const publisher_domain of invalidDomains) {
      const result = await handler.handleToolCall('save_property', { publisher_domain }, {
        sub: 'test_user', email: 'buyer@pinnacle.example', isM2M: false, payload: {},
      });
      expect(result.isError, String(publisher_domain)).toBe(true);
    }
    expectNoPropertyAccess();
  });

  it('rejects invalid enhancement domains before external research or persistence', async () => {
    for (const domain of invalidDomains) {
      const result = JSON.parse(await addieHandlers.get('enhance_property')!({ domain }));
      expect(result.error, String(domain)).toMatch(/domain/);
    }
    expect(mocks.enhanceProperty).not.toHaveBeenCalled();
    expectNoPropertyAccess();
  });

  it('rejects an entire mixed catalog contribution before reaching the database', async () => {
    for (const value of ['publisher.example', 'https://publisher.com/path']) {
      const result = JSON.parse(await addieHandlers.get('resolve_catalog')!({
        identifiers: [{ type: 'domain', value: 'publisher.com' }, { type: 'domain', value }],
        provenance: { type: 'agency_allowlist' },
      }));
      expect(result.error).toBe('Invalid request');
      expect(result.details[0].path).toEqual(['identifiers', 1, 'value']);
    }
    expect(catalogResolve).not.toHaveBeenCalled();
    expectNoPropertyAccess();
  });

  it('passes a sandbox contribution through to the non-persistent catalog path', async () => {
    catalogResolve.mockResolvedValueOnce({
      sandbox: true, resolved: [],
      summary: { total: 1, resolved: 0, created: 0, excluded: 0, not_found: 1 },
      server_timestamp: '2026-10-17T00:00:00Z',
    });
    const identifiers = [{ type: 'domain', value: 'publisher.example' }];
    const provenance = { type: 'agency_allowlist' };
    const result = JSON.parse(await addieHandlers.get('resolve_catalog')!({ identifiers, provenance, sandbox: true }));
    expect(catalogResolve).toHaveBeenCalledWith(identifiers, 'resolve', 'system:addie', provenance, { sandbox: true });
    expect(result.sandbox).toBe(true);
    expectNoPropertyAccess();
  });
});
