/**
 * Integration coverage for brand.json hydration on /api/registry/publisher.
 *
 * Scenario: a publisher domain has nothing in the federated index (no
 * adagents.json crawl, no discovered properties), but a brand.json with
 * a populated `properties[]` exists in the brands table. The endpoint
 * must hydrate properties from brand.json and tag them `source=brand_json`
 * so callers can tell where the data came from.
 *
 * Fixtures use a `brand-hydrate-` prefix on a `.registry-baseline.example`
 * suffix so we don't collide with the sibling reader-baseline test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

const TEST_USER_ID = 'user_test_registry_brand_hydrate';
vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/middleware/auth.js'
  );
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: TEST_USER_ID, email: 'registry-brand-hydrate@test.com' };
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
import { BrandDatabase } from '../../src/db/brand-db.js';
import { PropertyDatabase } from '../../src/db/property-db.js';

const DOMAIN_SUFFIX = '.registry-baseline.example';
const DOMAIN_PREFIX = 'brand-hydrate-';
const PUB_BRAND_ONLY = `${DOMAIN_PREFIX}sasha${DOMAIN_SUFFIX}`;
const PUB_AAO_HOSTED = `${DOMAIN_PREFIX}aao-hosted${DOMAIN_SUFFIX}`;

describe('Registry publisher endpoint — brand.json hydration', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let brandDb: BrandDatabase;
  let propertyDb: PropertyDatabase;

  const DOMAIN_LIKE = `${DOMAIN_PREFIX}%${DOMAIN_SUFFIX}`;

  async function clearFixtures() {
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query('DELETE FROM brands WHERE domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain LIKE $1',
      [DOMAIN_LIKE]
    );
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
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

  it('hydrates properties from brand.json when the federated index is empty', async () => {
    await brandDb.upsertDiscoveredBrand({
      domain: PUB_BRAND_ONLY,
      brand_name: 'Sasha Media',
      source_type: 'brand_json',
      has_brand_manifest: true,
      brand_manifest: {
        name: 'Sasha Media',
        properties: [
          { identifier: PUB_BRAND_ONLY, type: 'website', relationship: 'owned' },
          {
            identifier: `news.${PUB_BRAND_ONLY}`,
            type: 'website',
            relationship: 'direct',
          },
        ],
      },
    });

    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB_BRAND_ONLY)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.domain).toBe(PUB_BRAND_ONLY);
    expect(res.body.properties).toHaveLength(2);

    const propsByName = new Map<string, { source: string; type: string; identifiers: unknown[] }>(
      res.body.properties.map((p: { name: string }) => [p.name, p])
    );
    const root = propsByName.get(PUB_BRAND_ONLY);
    expect(root).toBeDefined();
    expect(root?.source).toBe('brand_json');
    expect(root?.type).toBe('website');
    expect(root?.identifiers).toEqual([{ type: 'domain', value: PUB_BRAND_ONLY }]);

    const news = propsByName.get(`news.${PUB_BRAND_ONLY}`);
    expect(news?.source).toBe('brand_json');
  });

  it('returns empty properties when there is no brand.json and no federated-index data', async () => {
    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB_BRAND_ONLY)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.properties).toEqual([]);
  });

  it('does not hydrate from brand.json when brand_manifest has no properties', async () => {
    await brandDb.upsertDiscoveredBrand({
      domain: PUB_BRAND_ONLY,
      brand_name: 'Sasha Media',
      source_type: 'brand_json',
      has_brand_manifest: true,
      brand_manifest: { name: 'Sasha Media' },
    });

    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB_BRAND_ONLY)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.properties).toEqual([]);
  });

  it('does NOT compute per-agent rollup when all properties are brand_json-sourced', async () => {
    // Set up a brand.json hydration scenario AND an authorized agent.
    // Without rollup suppression, the agent would be reported as
    // authorized for N of N properties — over-claiming, since no
    // adagents.json has actually scoped this agent to those properties.
    await brandDb.upsertDiscoveredBrand({
      domain: PUB_BRAND_ONLY,
      brand_name: 'Sasha Media',
      source_type: 'brand_json',
      has_brand_manifest: true,
      brand_manifest: {
        name: 'Sasha Media',
        properties: [
          { identifier: PUB_BRAND_ONLY, type: 'website', relationship: 'owned' },
        ],
      },
    });
    // Plant an agent claim — without an adagents.json this is the only
    // path agents can appear here.
    await pool.query(
      `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source)
       VALUES ($1, $2, 'agent_claim')
       ON CONFLICT DO NOTHING`,
      ['https://claiming-agent.brand-hydrate.example', PUB_BRAND_ONLY],
    );

    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB_BRAND_ONLY)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.properties).toHaveLength(1);
    expect(res.body.authorized_agents).toHaveLength(1);
    const agent = res.body.authorized_agents[0];
    expect(agent.properties_authorized).toBeUndefined();
    expect(agent.properties_total).toBeUndefined();
    expect(agent.publisher_wide).toBeUndefined();

    // Cleanup the planted authorization (other tests use the same domain).
    await pool.query(
      `DELETE FROM agent_publisher_authorizations WHERE agent_url = $1`,
      ['https://claiming-agent.brand-hydrate.example'],
    );
  });

  it('reports hosting.mode=none when no adagents.json is configured', async () => {
    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB_BRAND_ONLY)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.hosting).toMatchObject({
      mode: 'none',
      expected_url: `https://${PUB_BRAND_ONLY}/.well-known/adagents.json`,
    });
    expect(res.body.hosting.hosted_url).toBeUndefined();
  });

  it('reports hosting.mode=aao_hosted with hosted_url when a public hosted property exists', async () => {
    await propertyDb.createHostedProperty({
      publisher_domain: PUB_AAO_HOSTED,
      adagents_json: { authorized_agents: [], properties: [] },
      is_public: true,
      source_type: 'community',
    });

    const res = await request(app).get(
      `/api/registry/publisher?domain=${encodeURIComponent(PUB_AAO_HOSTED)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.hosting).toMatchObject({
      mode: 'aao_hosted',
      hosted_url: `https://agenticadvertising.org/publisher/${PUB_AAO_HOSTED}/.well-known/adagents.json`,
      expected_url: `https://${PUB_AAO_HOSTED}/.well-known/adagents.json`,
    });
  });
});
