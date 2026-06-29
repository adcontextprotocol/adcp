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
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'user_save_test', email: 'save@test.com', isAdmin: false };
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

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import { HTTPServer } from '../../src/http.js';

const DOMAIN_PREFIX = 'save-identity';
const DOMAIN_LIKE = `${DOMAIN_PREFIX}-%`;
const WITH_AGENTS = `${DOMAIN_PREFIX}-with-agents.registry-baseline.example`;
const NO_AGENTS = `${DOMAIN_PREFIX}-no-agents.registry-baseline.example`;
const EDIT_DOMAIN = `${DOMAIN_PREFIX}-edit.registry-baseline.example`;

describe('POST /api/properties/save — identity, not authorization', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
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
  });

  afterAll(async () => {
    await clearFixtures();
    await server?.stop();
    await closeDatabase();
  });

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
});
