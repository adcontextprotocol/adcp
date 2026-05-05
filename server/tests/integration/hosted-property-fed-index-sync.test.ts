/**
 * Integration coverage for hosted-property → federated-index propagation.
 *
 * When a publisher opts into AAO hosting (a public hosted_properties row),
 * the agents and properties declared in `adagents_json` must show up in
 * `/api/registry/publisher` for that domain. Without this propagation,
 * AAO-hosted publishers appear with 0 agents in discovery — even though
 * the canonical adagents.json document AAO is serving says otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/middleware/auth.js'
  );
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'user_test_hosted_sync', email: 'hosted-sync@test.com' };
    next();
  };
  return {
    ...actual,
    requireAuth: pass,
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/middleware/csrf.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/middleware/csrf.js'
  );
  return {
    ...actual,
    csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import { syncHostedPropertyToFederatedIndex } from '../../src/services/hosted-property-sync.js';

const PUB = 'devraj-sync.registry-baseline.example';
const AGENT_X = 'https://agent-x-sync.registry-baseline.example';
const AGENT_Y = 'https://agent-y-sync.registry-baseline.example';
const DOMAIN_LIKE = 'devraj-sync.%';
const AGENT_LIKE_X = 'https://agent-%-sync.registry-baseline.example';

describe('Hosted property → federated index sync', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_publisher_authorizations WHERE publisher_domain LIKE $1 OR agent_url LIKE $2`,
      [DOMAIN_LIKE, AGENT_LIKE_X]
    );
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query('DELETE FROM discovered_agents WHERE agent_url LIKE $1', [AGENT_LIKE_X]);
    await pool.query('DELETE FROM discovered_publishers WHERE domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
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

  it('propagates a public hosted property into the federated index', async () => {
    const adagents = {
      authorized_agents: [
        { url: AGENT_X, authorized_for: 'all' },
        { url: AGENT_Y },
      ],
      properties: [
        {
          property_id: 'home',
          type: 'website',
          name: PUB,
          identifiers: [{ type: 'domain', value: PUB }],
          tags: ['flagship'],
        },
        {
          property_id: 'mobile',
          type: 'mobile_app',
          name: `${PUB} app`,
          identifiers: [{ type: 'ios_bundle', value: 'com.devraj.app' }],
        },
      ],
    };

    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: adagents,
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB)}`
    );
    expect(res.status).toBe(200);

    const propsByName = new Map<string, { type: string }>(
      res.body.properties.map((p: { name: string }) => [p.name, p])
    );
    expect(propsByName.size).toBe(2);
    expect(propsByName.get(PUB)?.type).toBe('website');
    expect(propsByName.get(`${PUB} app`)?.type).toBe('mobile_app');

    const agentsByUrl = new Map(
      res.body.authorized_agents.map((a: { url: string }) => [a.url, a])
    );
    expect(agentsByUrl.size).toBe(2);
    expect(agentsByUrl.get(AGENT_X)).toMatchObject({
      url: AGENT_X,
      authorized_for: 'all',
      source: 'aao_hosted',
    });
    expect(agentsByUrl.get(AGENT_Y)).toMatchObject({
      url: AGENT_Y,
      source: 'aao_hosted',
    });
  });

  it('does not propagate when is_public is false', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: {
        authorized_agents: [{ url: AGENT_X }],
        properties: [{ type: 'website', name: PUB }],
      },
      is_public: false,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.properties).toEqual([]);
    expect(res.body.authorized_agents).toEqual([]);
  });

  it('reconciles authorizations on re-sync: agents removed from the manifest are deleted', async () => {
    const initial = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: {
        authorized_agents: [
          { url: AGENT_X, authorized_for: 'all' },
          { url: AGENT_Y },
        ],
        properties: [{ type: 'website', name: PUB }],
      },
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(initial);

    // Sanity: both agents present.
    let res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB)}`
    );
    expect(res.body.authorized_agents).toHaveLength(2);

    // Re-sync with only one agent — the other should be removed.
    await pool.query(
      `UPDATE hosted_properties
          SET adagents_json = $2
        WHERE publisher_domain = $1`,
      [PUB, JSON.stringify({
        authorized_agents: [{ url: AGENT_X, authorized_for: 'all' }],
        properties: [{ type: 'website', name: PUB }],
      })],
    );
    const updated = await propertyDb.getHostedPropertyByDomain(PUB);
    if (!updated) throw new Error('expected hosted property to exist');
    const result = await syncHostedPropertyToFederatedIndex(updated);
    expect(result.authorizations_removed).toBe(1);

    res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB)}`
    );
    expect(res.body.authorized_agents).toHaveLength(1);
    expect(res.body.authorized_agents[0].url).toBe(AGENT_X);
  });

  it('skips entries without required fields without throwing', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: {
        authorized_agents: [{ url: AGENT_X }, { authorized_for: 'malformed' }],
        properties: [
          { type: 'website', name: PUB },
          { type: 'website' /* no name */ },
        ],
      },
      is_public: true,
      source_type: 'community',
    });
    await expect(syncHostedPropertyToFederatedIndex(hosted)).resolves.not.toThrow();

    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.properties).toHaveLength(1);
    expect(res.body.authorized_agents).toHaveLength(1);
  });
});
