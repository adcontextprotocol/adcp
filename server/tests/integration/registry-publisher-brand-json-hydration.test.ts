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

// Short-circuit the SSRF DNS check for the auto-crawl path. The
// `.registry-baseline.example` test domains don't resolve to a public
// IP (RFC 2606 reserved), so the production `validateCrawlDomain` would
// reject them and skip auto-crawl. We want to exercise the auto-crawl
// branch in tests, so the mock returns the input domain unchanged.
vi.mock('../../src/utils/url-security.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/utils/url-security.js');
  return {
    ...actual,
    validateCrawlDomain: async (domain: string) => domain.toLowerCase(),
  };
});

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

  it('does NOT auto-crawl when validateCrawlDomain rejects (SSRF gate)', async () => {
    // Override the global mock for this one case. We want to exercise
    // the path where the SSRF gate refuses the domain — auto-crawl
    // should be skipped, no `auto_crawl_triggered` flag in the response.
    const urlSecurity = await import('../../src/utils/url-security.js');
    const original = urlSecurity.validateCrawlDomain;
    (urlSecurity as unknown as { validateCrawlDomain: typeof original }).validateCrawlDomain = async () => {
      throw new Error('Invalid host: test rejection');
    };
    try {
      const ssrfTarget = `ssrf-target-${Date.now()}.registry-baseline.example`;
      const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(ssrfTarget)}`);
      expect(res.status).toBe(200);
      expect(res.body.auto_crawl_triggered).toBeUndefined();
      // Status falls back to `unknown` (not `checking`) because the
      // gate prevented us from kicking off any crawl.
      expect(res.body.files.adagents_json.status).toBe('unknown');
      expect(res.body.files.brand_json.status).toBe('unknown');
    } finally {
      (urlSecurity as unknown as { validateCrawlDomain: typeof original }).validateCrawlDomain = original;
    }
  });

  it('returns files.adagents_json.status=checking and auto_crawl_triggered=true on first lookup of an unknown domain', async () => {
    // No brand row, no hosted property, never crawled — first GET should
    // kick off an auto-crawl and surface the checking states.
    const fresh = `auto-crawl-${Date.now()}.registry-baseline.example`;
    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(fresh)}`);
    expect(res.status).toBe(200);
    expect(res.body.auto_crawl_triggered).toBe(true);
    expect(res.body.files).toBeDefined();
    // First hit: auto_crawl_triggered=true and the never-crawled files
    // are reported as `checking` (not `unknown`).
    expect(res.body.files.adagents_json.status).toBe('checking');
    expect(res.body.files.brand_json.status).toBe('checking');

    // Second hit within the debounce window does NOT re-trigger.
    const res2 = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(fresh)}`);
    expect(res2.status).toBe(200);
    expect(res2.body.auto_crawl_triggered).toBeUndefined();
  });

  it('returns files.brand_json.status=present when a brand record exists', async () => {
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
    expect(res.body.files.brand_json).toMatchObject({
      status: 'present',
      name: 'Sasha Media',
    });
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
