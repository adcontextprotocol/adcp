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
import { PublisherDatabase } from '../../src/db/publisher-db.js';
import { aaoHostedAdagentsJsonUrl } from '../../src/config/aao.js';

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
  let publisherDb: PublisherDatabase;

  const DOMAIN_LIKE = `${DOMAIN_PREFIX}%${DOMAIN_SUFFIX}`;

  async function clearFixtures() {
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query('DELETE FROM brands WHERE domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query('DELETE FROM publishers WHERE domain LIKE $1', [DOMAIN_LIKE]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
    propertyDb = new PropertyDatabase();
    publisherDb = new PublisherDatabase();
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

  it('re-triggers brand crawl when a stub row exists without a manifest', async () => {
    // Set up a brand row that mirrors the production state we saw on
    // wonderstruck.org: brand row exists (the discovery path stamps a
    // brand_name from the domain literal), but has_brand_manifest is
    // false because a prior crawl came up empty. The auto-crawl logic
    // must NOT treat this as "already crawled" — the publisher's
    // origin may now actually serve a brand.json that we never picked
    // up. Re-trigger and surface `checking`.
    const stubDomain = `stub-no-manifest-${Date.now()}.registry-baseline.example`;
    await brandDb.upsertDiscoveredBrand({
      domain: stubDomain,
      brand_name: stubDomain, // domain-literal placeholder, no real metadata
      source_type: 'community',
      has_brand_manifest: false,
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(stubDomain)}`);
    expect(res.status).toBe(200);
    expect(res.body.auto_crawl_triggered).toBe(true);
    // Status reflects the in-flight re-crawl.
    expect(res.body.files.brand_json.status).toBe('checking');
    // Name is suppressed when there's no real manifest — the
    // domain-literal placeholder is misleading.
    expect(res.body.files.brand_json.name).toBeUndefined();
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

  it('reports hosting.mode=aao_hosted when a public hosted property exists and origin is not yet serving', async () => {
    // Pure intent-only opt-in: publisher created a hosted_properties row
    // but their /.well-known has not yet been crawled successfully.
    // AAO's hosted document acts as the canonical source.
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

  it('reports hosting.mode=self when origin self-hosts a valid full doc despite a stale AAO opt-in row', async () => {
    // Wonderstruck-shaped regression: a publisher who once opted into
    // AAO hosting and later migrated to self-hosting must surface as
    // `self`, not `aao_hosted`. The hosted_properties row never
    // auto-revokes — the live origin file is the authoritative signal.
    const pub = `migrated-self-${Date.now()}.registry-baseline.example`;
    await propertyDb.createHostedProperty({
      publisher_domain: pub,
      adagents_json: { authorized_agents: [], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    // Live origin serves a valid full document (no authoritative_location).
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: {
        authorized_agents: [
          { url: 'https://agent.example.com', authorized_for: 'display' },
        ],
        properties: [
          {
            property_type: 'website',
            name: 'Main site',
            identifiers: [{ type: 'domain', value: pub }],
          },
        ],
      },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.mode).toBe('self');
    expect(res.body.hosting.hosted_url).toBeUndefined();
    expect(res.body.adagents_valid).toBe(true);
  });

  it('reports hosting.mode=aao_hosted when origin serves a stub with authoritative_location pointing at AAO', async () => {
    // Spec-conformant AAO hosting flow: publisher's /.well-known
    // returns a stub whose authoritative_location resolves to AAO's
    // hosted URL. Crawler caches the original (stub) response, the
    // route detects the pointer and reports aao_hosted.
    const pub = `stub-points-aao-${Date.now()}.registry-baseline.example`;
    await propertyDb.createHostedProperty({
      publisher_domain: pub,
      adagents_json: { authorized_agents: [], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: {
        authoritative_location: aaoHostedAdagentsJsonUrl(pub),
        authorized_agents: [],
        properties: [],
      },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.mode).toBe('aao_hosted');
    expect(res.body.hosting.hosted_url).toBe(aaoHostedAdagentsJsonUrl(pub));
  });

  it('tags federated-index properties with source=adagents_json when the publisher serves a valid adagents.json', async () => {
    // Wonderstruck-shaped regression: properties listed in the live
    // adagents.json were being labelled `discovered` (i.e. "found by
    // crawler"), erasing the fact that the publisher explicitly
    // declared them. With a valid adagents.json present, the federated
    // index entries are by definition adagents_json-sourced.
    const pub = `props-from-adagents-${Date.now()}.registry-baseline.example`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: {
        authorized_agents: [
          { url: 'https://agent.example.com', authorized_for: 'display' },
        ],
        properties: [
          {
            property_type: 'website',
            name: 'Main site',
            identifiers: [{ type: 'domain', value: pub }],
          },
        ],
      },
    });
    // Plant a federated-index row so the route's primary
    // getPropertiesForDomain path returns something to project.
    await pool.query(
      `INSERT INTO discovered_properties
         (publisher_domain, property_type, name, identifiers, tags, source_type)
       VALUES ($1, 'website', 'Main site', $2::jsonb, ARRAY[]::text[], 'adagents_json')`,
      [pub, JSON.stringify([{ type: 'domain', value: pub }])],
    );

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.properties).toHaveLength(1);
    expect(res.body.properties[0].source).toBe('adagents_json');
  });

  it('tags aao_hosted federated-index properties as adagents_json (publisher-attested via AAO hosting)', async () => {
    // hosted-property-sync writes discovered_properties rows with
    // source_type='aao_hosted' for publishers using AAO hosting. Both
    // 'adagents_json' and 'aao_hosted' are publisher-attested and
    // collapse to the schema's `adagents_json` value at the API
    // surface — neither should bleed through as the schema-level
    // `discovered` (which means "crawler-derived without first-party
    // attestation").
    const pub = `props-aao-hosted-${Date.now()}.registry-baseline.example`;
    await pool.query(
      `INSERT INTO discovered_properties
         (publisher_domain, property_type, name, identifiers, tags, source_type)
       VALUES ($1, 'website', 'Main site', $2::jsonb, ARRAY[]::text[], 'aao_hosted')`,
      [pub, JSON.stringify([{ type: 'domain', value: pub }])],
    );

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.properties).toHaveLength(1);
    expect(res.body.properties[0].source).toBe('adagents_json');
  });
});
