/**
 * `/api/properties/save` is an identity-only write surface: the stored
 * community-registry document must never assert sales authorization. The
 * owner's origin `adagents.json` is the sole authorization source, so the
 * handler drops any caller-supplied `authorized_agents` and persists
 * `authorized_agents: []` — matching the community-mirror write path
 * (`community-mirrors.ts`) and the adagents.json spec, where an empty array
 * asserts "no sales authorization".
 *
 * These tests exercise the handler end-to-end with an authenticated non-admin
 * caller and assert the persisted document, not the response shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://adcp:localdev@localhost:5432/adcp_test';
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'user_save_test', email: 'save@test.com', isAdmin: false, isMember: true };
    next();
  };
  return { ...actual, requireAuth: pass, requireAdmin: (_r: unknown, _s: unknown, n: () => void) => n() };
});

vi.mock('../../src/middleware/csrf.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/csrf.js');
  return { ...actual, csrfProtection: (_r: unknown, _s: unknown, n: () => void) => n() };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/notifications/registry.js', () => ({
  notifyRegistryCreate: vi.fn().mockResolvedValue(null),
  notifyRegistryEdit: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/addie/mcp/registry-review.js', () => ({
  reviewNewRecord: vi.fn().mockResolvedValue(undefined),
  reviewRegistryEdit: vi.fn().mockResolvedValue(undefined),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import { HTTPServer } from '../../src/http.js';
import { createPropertyToolHandlers, PROPERTY_TOOLS } from '../../src/addie/mcp/property-tools.js';
import { MCPToolHandler, TOOL_DEFINITIONS } from '../../src/mcp-tools.js';
import type { MCPAuthContext } from '../../src/mcp/auth.js';

const DOMAIN_PREFIX = 'save-identity';
const DOMAIN_LIKE = `${DOMAIN_PREFIX}-%`;
const WITH_AGENTS = `${DOMAIN_PREFIX}-with-agents.registry-baseline.example`;
const NO_AGENTS = `${DOMAIN_PREFIX}-no-agents.registry-baseline.example`;
const EDIT_DOMAIN = `${DOMAIN_PREFIX}-edit.registry-baseline.example`;
const HTTP_HOSTED_DOMAIN = `${DOMAIN_PREFIX}-http-hosted.registry-baseline.example`;
const HTTP_COMMUNITY_DOMAIN = `${DOMAIN_PREFIX}-http-community.registry-baseline.example`;
const HTTP_EDIT_DOMAIN = `${DOMAIN_PREFIX}-http-edit.registry-baseline.example`;
const ADDIE_DOMAIN = `${DOMAIN_PREFIX}-addie.registry-baseline.example`;
const MCP_DOMAIN = `${DOMAIN_PREFIX}-mcp.registry-baseline.example`;
const ATTACKER_AGENT = 'https://agent.attacker.example';

const mcpAuth: MCPAuthContext = {
  sub: 'user_save_test',
  isM2M: false,
  email: 'save@test.com',
  payload: {},
};

describe('POST /api/properties/save — identity, not authorization', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
    // Community creates write revision #1. Revisions are intentionally not
    // cascade-deleted with hosted properties, so clear them explicitly to
    // keep this suite repeatable against a persistent local test database.
    await pool.query('DELETE FROM property_revisions WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
    // The edit-path success case calls syncHostedPropertyToFederatedIndex, which
    // derives a discovered_properties row; clear it too so re-runs against a
    // persistent DB don't leave a row that trips the "authoritative" 409 guard.
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    propertyDb = new PropertyDatabase();
    server = new HTTPServer();
    await server.start(0);
    app = (server as unknown as { app: unknown }).app;
  }, 60000);

  afterAll(async () => {
    await clearFixtures();
    await server?.stop();
    await closeDatabase();
  }, 30000);

  beforeEach(async () => {
    await clearFixtures();
  });

  it('drops caller-supplied authorized_agents and stores authorized_agents:[]', async () => {
    const res = await request(app)
      .post('/api/properties/save')
      .send({
        publisher_domain: WITH_AGENTS,
        // A caller asserting a sales agent for a domain it does not own — the
        // exact spoof surface this endpoint must refuse to carry.
        authorized_agents: [{ url: 'https://agent.attacker.example' }],
        properties: [{ type: 'website', name: 'Save Identity Test' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const stored = await propertyDb.getHostedPropertyByDomain(WITH_AGENTS);
    expect(stored).not.toBeNull();
    const adagents = stored!.adagents_json as { authorized_agents: unknown[]; properties: unknown[] };
    expect(adagents.authorized_agents).toEqual([]);
    // Identity content (properties) is preserved — only authorization is dropped.
    expect(adagents.properties).toHaveLength(1);
  });

  it('accepts a save with no authorized_agents (the field is optional, not required)', async () => {
    const res = await request(app)
      .post('/api/properties/save')
      .send({
        publisher_domain: NO_AGENTS,
        properties: [{ type: 'website', name: 'No Agents Test' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const stored = await propertyDb.getHostedPropertyByDomain(NO_AGENTS);
    expect(stored).not.toBeNull();
    const adagents = stored!.adagents_json as { authorized_agents: unknown[] };
    expect(adagents.authorized_agents).toEqual([]);
  });

  it('overwrites a previously-stored non-empty authorized_agents to [] on edit (heals a prior spoof)', async () => {
    // Seed an existing community row that already holds a (spoofed) sales
    // authorization. review_status:'approved' so the edit path is reachable
    // (pending rows 409). This is the state a pre-fix write could have left.
    await propertyDb.createHostedProperty({
      publisher_domain: EDIT_DOMAIN,
      adagents_json: {
        $schema: 'https://adcontextprotocol.org/schemas/latest/adagents.json',
        authorized_agents: [{ url: 'https://stale.attacker.example' }],
        properties: [],
      },
      source_type: 'community',
      review_status: 'approved',
      is_public: true,
    });

    const res = await request(app)
      .post('/api/properties/save')
      .send({
        publisher_domain: EDIT_DOMAIN,
        properties: [{ type: 'website', name: 'Edit Path Test' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // revision_number is only present on the edit branch — proves we took it.
    expect(typeof res.body.revision_number).toBe('number');

    const stored = await propertyDb.getHostedPropertyByDomain(EDIT_DOMAIN);
    expect(stored).not.toBeNull();
    const adagents = stored!.adagents_json as { authorized_agents: unknown[] };
    expect(adagents.authorized_agents).toEqual([]);
  });

  it('scrubs caller authorization on the authenticated hosted-property create route', async () => {
    const res = await request(app)
      .post('/api/properties/hosted')
      .send({
        publisher_domain: HTTP_HOSTED_DOMAIN,
        adagents_json: {
          authorized_agents: [{ url: ATTACKER_AGENT }],
          properties: [{ type: 'website', name: 'Hosted route' }],
        },
      });

    expect(res.status).toBe(200);
    const stored = await propertyDb.getHostedPropertyByDomain(HTTP_HOSTED_DOMAIN);
    expect((stored!.adagents_json as { authorized_agents: unknown[] }).authorized_agents).toEqual([]);
  });

  it('scrubs caller authorization on the member community-property create route', async () => {
    const res = await request(app)
      .post('/api/properties/hosted/community')
      .send({
        publisher_domain: HTTP_COMMUNITY_DOMAIN,
        adagents_json: {
          authorized_agents: [{ url: ATTACKER_AGENT }],
          properties: [{ type: 'website', name: 'Community route' }],
        },
      });

    expect(res.status).toBe(200);
    const stored = await propertyDb.getHostedPropertyByDomain(HTTP_COMMUNITY_DOMAIN);
    expect((stored!.adagents_json as { authorized_agents: unknown[] }).authorized_agents).toEqual([]);
  });

  it('scrubs caller authorization on the member community-property edit route', async () => {
    await propertyDb.createHostedProperty({
      publisher_domain: HTTP_EDIT_DOMAIN,
      adagents_json: { authorized_agents: [{ url: ATTACKER_AGENT }], properties: [] },
      source_type: 'community',
      review_status: 'approved',
      is_public: true,
    });

    const res = await request(app)
      .put(`/api/properties/hosted/${encodeURIComponent(HTTP_EDIT_DOMAIN)}`)
      .send({
        edit_summary: 'Identity-only edit',
        adagents_json: {
          authorized_agents: [{ url: 'https://replacement.attacker.example' }],
          properties: [{ type: 'website', name: 'Edited route' }],
        },
      });

    expect(res.status).toBe(200);
    const stored = await propertyDb.getHostedPropertyByDomain(HTTP_EDIT_DOMAIN);
    expect((stored!.adagents_json as { authorized_agents: unknown[] }).authorized_agents).toEqual([]);
  });

  it('scrubs supplied and previously-preserved authorization on Addie approval', async () => {
    await propertyDb.createHostedProperty({
      publisher_domain: ADDIE_DOMAIN,
      adagents_json: { authorized_agents: [{ url: ATTACKER_AGENT }], properties: [] },
      source_type: 'community',
      review_status: 'pending',
      is_public: false,
    });

    const saveProperty = createPropertyToolHandlers().get('save_property');
    const result = JSON.parse(await saveProperty!({
      publisher_domain: ADDIE_DOMAIN,
      authorized_agents: [{ url: 'https://replacement.attacker.example' }],
      properties: [],
    }));

    expect(result.success).toBe(true);
    const stored = await propertyDb.getHostedPropertyByDomain(ADDIE_DOMAIN);
    expect((stored!.adagents_json as { authorized_agents: unknown[] }).authorized_agents).toEqual([]);
  });

  it('scrubs caller authorization on the authenticated directory MCP tool', async () => {
    const result = await new MCPToolHandler().handleToolCall('save_property', {
      publisher_domain: MCP_DOMAIN,
      authorized_agents: [{ url: ATTACKER_AGENT }],
      properties: [{ type: 'website', name: 'MCP route' }],
    }, mcpAuth);

    expect(result.isError).not.toBe(true);
    const stored = await propertyDb.getHostedPropertyByDomain(MCP_DOMAIN);
    expect((stored!.adagents_json as { authorized_agents: unknown[] }).authorized_agents).toEqual([]);
  });

  it('does not advertise authorized_agents on Addie or directory MCP save tools', () => {
    const addieTool = PROPERTY_TOOLS.find(tool => tool.name === 'save_property');
    const directoryTool = TOOL_DEFINITIONS.find(tool => tool.name === 'save_property');

    expect(addieTool?.input_schema.properties).not.toHaveProperty('authorized_agents');
    expect(directoryTool?.inputSchema.properties).not.toHaveProperty('authorized_agents');
  });
});
