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

// Disable the per-IP rate limiter for the publisher endpoint. The
// production limiter is 20 req/min/IP; this file now has >20 tests
// each issuing a request from the same supertest origin. The rate
// limiter is exercised end-to-end by other test files.
vi.mock('../../src/middleware/rate-limit.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/middleware/rate-limit.js'
  );
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...actual,
    registryPublisherRateLimiter: passthrough,
    registryReadRateLimiter: passthrough,
    agentReadRateLimiter: passthrough,
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

  it('reports hosting.mode=self_redirected when the stub authoritative_location points at a third-party HTTPS origin', async () => {
    // Publisher's /.well-known stub redirects the canonical document
    // to a CDN or partner CMS — neither AAO nor their own origin. The
    // distinction matters for verifiers: the TLS chain that signs the
    // canonical body terminates at the third-party host, not at the
    // publisher's own domain. Without a separate mode the route would
    // mislabel this as `self`, and a buyer-side scraper would assume
    // wrong about origin trust.
    const pub = `cdn-redirect-${Date.now()}.registry-baseline.example`;
    const cdnUrl = `https://cdn-host-${Date.now()}.example.test/adagents.json`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: {
        authoritative_location: cdnUrl,
        authorized_agents: [],
        properties: [],
      },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.mode).toBe('self_redirected');
    expect(res.body.hosting.resolved_url).toBe(cdnUrl);
    expect(res.body.hosting.hosted_url).toBeUndefined();
  });

  it('treats stub authoritative_location with http:// scheme as self_invalid (not self_redirected)', async () => {
    // The schema description for `self_redirected` promises a
    // third-party HTTPS origin. A publisher pointing at cleartext is
    // mis-configured — it isn't a usable trust anchor for buy-side
    // verifiers, so we route it through `self_invalid` instead of
    // promoting it as a valid third-party-hosted document.
    const pub = `http-stub-${Date.now()}.registry-baseline.example`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: {
        authoritative_location: 'http://insecure-cdn.example.test/adagents.json',
        authorized_agents: [],
        properties: [],
      },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.mode).toBe('self_invalid');
    expect(res.body.hosting.resolved_url).toBeNull();
  });

  it('does not flag self_redirected when the stub points back at the publisher\'s own origin', async () => {
    // Edge: a no-op stub whose authoritative_location resolves to the
    // publisher's own /.well-known. Should be treated as `self`, not
    // self_redirected — there's no third-party trust shift.
    const pub = `noop-stub-${Date.now()}.registry-baseline.example`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: {
        authoritative_location: `https://${pub}/.well-known/adagents.json`,
        authorized_agents: [],
        properties: [],
      },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.mode).toBe('self');
    expect(res.body.hosting.resolved_url).toBeNull();
  });

  it('surfaces last_validated when the publisher row has been crawled', async () => {
    // Hero chrome relies on `last_validated`. Sanity check that the
    // route plumbs it through from the publishers row. upsertAdagentsCache
    // sets it to NOW().
    const pub = `last-validated-${Date.now()}.registry-baseline.example`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: { authorized_agents: [], properties: [] },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.last_validated).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('surfaces Phase B fetch metadata: last_http_status, last_bytes, resolved_url', async () => {
    const pub = `phase-b-${Date.now()}.registry-baseline.example`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: { authorized_agents: [], properties: [] },
      statusCode: 200,
      responseBytes: 1438,
      resolvedUrl: `https://${pub}/.well-known/adagents.json`,
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.last_http_status).toBe(200);
    expect(res.body.hosting.last_bytes).toBe(1438);
    // For mode === 'self', resolved_url is null in the response shape
    // even though the column is populated — it's only surfaced when
    // self_redirected. The column-vs-response distinction is intentional
    // (verifier audit hook only kicks in when the chain has actually
    // shifted).
    expect(res.body.hosting.resolved_url).toBeNull();
  });

  it('detects Case-B self_redirected via HTTP-layer redirect (no authoritative_location in JSONB)', async () => {
    // Phase B closes the gap where the publisher's /.well-known
    // serves a 301/302 to a third-party host with NO
    // `authoritative_location` field in the manifest body. Phase A
    // could only see Case A (JSONB-based redirection); Case B requires
    // the resolved_url column to be populated.
    const pub = `case-b-redirect-${Date.now()}.registry-baseline.example`;
    const cdnUrl = `https://cdn-${Date.now()}.example.test/adagents.json`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      // Note: no authoritative_location in the manifest. The redirect
      // happened at the HTTP layer, not as an in-document pointer.
      manifest: { authorized_agents: [], properties: [] },
      statusCode: 200,
      resolvedUrl: cdnUrl,
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.mode).toBe('self_redirected');
    expect(res.body.hosting.resolved_url).toBe(cdnUrl);
  });

  it('detects aao_hosted via Case-B HTTP redirect to AAO (no authoritative_location)', async () => {
    // Edge: publisher's /.well-known returns a 301 to AAO's hosted
    // URL. There's no authoritative_location field but the network
    // layer pointed at AAO. Should resolve to aao_hosted.
    const pub = `case-b-aao-${Date.now()}.registry-baseline.example`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: { authorized_agents: [], properties: [] },
      statusCode: 200,
      resolvedUrl: aaoHostedAdagentsJsonUrl(pub),
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.mode).toBe('aao_hosted');
    expect(res.body.hosting.hosted_url).toBe(aaoHostedAdagentsJsonUrl(pub));
  });

  it('gracefully handles NULL Phase B metadata (legacy rows pre-deploy)', async () => {
    // Existing publishers rows from before Phase B have NULL for
    // last_http_status / last_response_bytes / resolved_url. The API
    // surfaces them as null; the UI degrades gracefully (verification
    // chrome omits the row when typeof !== 'number').
    const pub = `legacy-row-${Date.now()}.registry-baseline.example`;
    await publisherDb.upsertAdagentsCache({
      domain: pub,
      manifest: { authorized_agents: [], properties: [] },
      // No statusCode / responseBytes / resolvedUrl supplied.
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.last_http_status).toBeNull();
    expect(res.body.hosting.last_bytes).toBeNull();
    expect(res.body.hosting.resolved_url).toBeNull();
  });

  it('records failed-fetch metadata via recordFailedAdagentsFetch even when no manifest is cached', async () => {
    // After Phase B the crawler calls recordFailedAdagentsFetch on
    // 4xx/5xx responses so the verifier UI can show
    // "Last attempted: <ts> · HTTP 404" even when no manifest was
    // stored. The row is created with source_type='community' so
    // adagents_valid still reports null/false.
    const pub = `failed-fetch-${Date.now()}.registry-baseline.example`;
    await publisherDb.recordFailedAdagentsFetch({
      domain: pub,
      statusCode: 404,
      responseBytes: 162,
      resolvedUrl: `https://${pub}/.well-known/adagents.json`,
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.hosting.last_http_status).toBe(404);
    expect(res.body.hosting.last_bytes).toBe(162);
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

  it('triggers a re-crawl when the cached manifest carries an agent the federated index is missing and the row is >1h old', async () => {
    // Drift case: a previous crawl wrote the cache (publishers.adagents_json
    // with 2 agents) but the per-agent upsert for one of them silently
    // failed (or the publisher added the second agent after we cached the
    // file). The federated index has only the first agent. An anonymous
    // visit to /publisher/<domain> must re-trigger the crawl so the index
    // catches up — without this, the publisher has no path to recovery
    // that doesn't require signing in to hit "Refresh now."
    const pub = `index-diverged-${Date.now()}.registry-baseline.example`;
    const agentInIndex = 'https://agent-known.example';
    const agentMissing = 'https://agent-missing.example';

    // Write the publishers cache row directly. We deliberately bypass
    // upsertAdagentsCache because that helper ALSO projects the manifest
    // into catalog_agent_authorizations, which would seed the federated
    // index with both agents and erase the divergence we're trying to
    // simulate. The wonderstruck-shaped failure is exactly: cache has
    // both agents, but only the legacy half (or only the catalog half)
    // landed for one of them.
    await pool.query(
      `INSERT INTO publishers (domain, adagents_json, source_type, last_validated)
       VALUES ($1, $2::jsonb, 'adagents_json', NOW() - INTERVAL '2 hours')`,
      [
        pub,
        JSON.stringify({
          authorized_agents: [
            { url: agentInIndex, authorized_for: 'display' },
            { url: agentMissing, authorized_for: 'display' },
          ],
          properties: [],
        }),
      ],
    );

    // Plant exactly one of the two agents in the legacy authorization
    // table. The federated-index UNION reads legacy + catalog; with no
    // catalog projection, the reader returns only this single agent —
    // matching the production drift case.
    await pool.query(
      `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source)
       VALUES ($1, $2, 'adagents_json')`,
      [agentInIndex, pub],
    );

    // brand row exists with manifest so brand-staleness can't be the
    // re-crawl reason — only divergence remains.
    await brandDb.upsertDiscoveredBrand({
      domain: pub,
      brand_name: 'Index Diverged Co',
      source_type: 'brand_json',
      has_brand_manifest: true,
      brand_manifest: { name: 'Index Diverged Co' },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.adagents_valid).toBe(true);
    expect(res.body.auto_crawl_triggered).toBe(true);
    // Cleanup: the planted authorization will leak across tests
    // otherwise (the LIKE delete in clearFixtures only catches by
    // publisher_domain prefix, which works here).
    await pool.query(
      `DELETE FROM agent_publisher_authorizations WHERE publisher_domain = $1`,
      [pub],
    );
  });

  it('does NOT re-crawl on divergence when the cached manifest is fresh', async () => {
    // Counterpart to the previous test: same shape (cache has 2 agents,
    // index has 1) but last_validated is recent, so the in-flight crawl
    // hasn't finished writing yet. We must not re-trigger and stomp on
    // its writes.
    const pub = `index-diverged-fresh-${Date.now()}.registry-baseline.example`;
    await pool.query(
      `INSERT INTO publishers (domain, adagents_json, source_type, last_validated)
       VALUES ($1, $2::jsonb, 'adagents_json', NOW())`,
      [
        pub,
        JSON.stringify({
          authorized_agents: [
            { url: 'https://agent-1.example', authorized_for: 'display' },
            { url: 'https://agent-2.example', authorized_for: 'display' },
          ],
          properties: [],
        }),
      ],
    );
    await pool.query(
      `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source)
       VALUES ($1, $2, 'adagents_json')`,
      ['https://agent-1.example', pub],
    );
    await brandDb.upsertDiscoveredBrand({
      domain: pub,
      brand_name: 'Fresh Diverged Co',
      source_type: 'brand_json',
      has_brand_manifest: true,
      brand_manifest: { name: 'Fresh Diverged Co' },
    });

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(pub)}`);
    expect(res.status).toBe(200);
    expect(res.body.adagents_valid).toBe(true);
    expect(res.body.auto_crawl_triggered).toBeUndefined();
    await pool.query(
      `DELETE FROM agent_publisher_authorizations WHERE publisher_domain = $1`,
      [pub],
    );
  });
});
