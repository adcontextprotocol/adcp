/**
 * Baseline coverage for the public registry HTTP endpoints ahead of the
 * property registry unification (issue #3177). PR 4 will swap the
 * federated-index readers under these endpoints to the new publishers /
 * adagents_authorization_overrides schema (#3195). Same fixtures must
 * produce the same response shapes before and after the cutover.
 *
 * Endpoints covered:
 *   - GET /api/registry/agents (with and without ?properties=true)
 *   - GET /api/registry/publishers
 *   - GET /api/registry/publisher?domain=X
 *   - GET /api/registry/operator?domain=X
 *   - GET /api/registry/stats
 *   - GET /api/registry/feed       (smoke test: 200 + envelope shape)
 *
 * Assertion discipline: response shapes, presence of our seeded entities,
 * counts/identities scoped to our test fixtures. We explicitly do NOT
 * assert top-level totals because the shared test DB carries other suites'
 * residue.
 *
 * Fixtures use the *.registry-baseline.example domain suffix with an
 * `endpoint-` prefix to keep us from colliding with the sibling baseline
 * files or any parallel registry-* test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

// Bypass WorkOS auth — the registry feed requires `requireAuth`. Stamp
// every request with a fixed test user. Other public registry endpoints
// use `optAuth` (no-op without a session), so the pass-through here is
// only load-bearing for /registry/feed.
const TEST_USER_ID = 'user_test_registry_baseline_endpoints';
vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/middleware/auth.js'
  );
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: TEST_USER_ID, email: 'registry-baseline@test.com' };
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

// Stop Stripe init from hitting the network on HTTPServer construction.
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
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';

// `endpoint-` prefix scopes this file's fixtures away from the sibling
// baseline files (prop-, auth-, mcp-) so concurrent file execution can't
// trample state.
const DOMAIN_SUFFIX = '.registry-baseline.example';
const DOMAIN_PREFIX = 'endpoint-';
const AGENT_PREFIX = 'https://endpoint-';
const PUB_A = `${DOMAIN_PREFIX}acme${DOMAIN_SUFFIX}`;
const PUB_B = `${DOMAIN_PREFIX}pinnacle${DOMAIN_SUFFIX}`;
const AGENT_X = `${AGENT_PREFIX}sales-x.registry-baseline.example`;
const AGENT_Y = `${AGENT_PREFIX}sales-y.registry-baseline.example`;
const ORG_ID = 'org_endpoint_registry_baseline';
const MEMBER_SLUG = 'endpoint-acme-baseline';

describe('Registry reader baseline — public endpoints', () => {
  let server: HTTPServer;
  // server.app is a private Express instance; we read it via `unknown` so
  // the test can hand it to supertest without depending on internal types.
  let app: unknown;
  let pool: Pool;
  let fedDb: FederatedIndexDatabase;

  const DOMAIN_LIKE = `${DOMAIN_PREFIX}%${DOMAIN_SUFFIX}`;
  const AGENT_LIKE = `${AGENT_PREFIX}%${DOMAIN_SUFFIX}`;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE property_id IN (
         SELECT id FROM discovered_properties WHERE publisher_domain LIKE $1
       )
          OR agent_url LIKE $2`,
      [DOMAIN_LIKE, AGENT_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM agent_publisher_authorizations WHERE publisher_domain LIKE $1 OR agent_url LIKE $2',
      [DOMAIN_LIKE, AGENT_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_publishers WHERE domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_agents WHERE agent_url LIKE $1',
      [AGENT_LIKE]
    );
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG_ID]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    fedDb = new FederatedIndexDatabase();
    server = new HTTPServer();
    await server.start(0);
    // server.app is private; unknown-typed handoff to supertest.
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

  // ──────────────────────────────────────────────────────────────────
  // Empty-suffix world: our seeded entities don't exist yet.
  // ──────────────────────────────────────────────────────────────────

  describe('with an empty suffix', () => {
    it('GET /api/registry/publisher returns null member + empty arrays for an unseen domain', async () => {
      const res = await request(app).get(
        `/api/registry/publisher?domain=${encodeURIComponent(PUB_A)}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        domain: PUB_A,
        member: null,
        properties: [],
        authorized_agents: [],
      });
      // adagents_valid is null when domain has never been crawled.
      expect(res.body.adagents_valid).toBeNull();
    });

    it('GET /api/registry/operator returns null member + empty agents for an unseen domain', async () => {
      const res = await request(app).get(
        `/api/registry/operator?domain=${encodeURIComponent(PUB_A)}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        domain: PUB_A,
        member: null,
        agents: [],
      });
    });

    it('GET /api/registry/publisher returns 400 when domain query is missing', async () => {
      const res = await request(app).get('/api/registry/publisher');
      expect(res.status).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Seeded fixtures: properties + agents + authorizations.
  // ──────────────────────────────────────────────────────────────────

  describe('with seeded fixtures', () => {
    beforeEach(async () => {
      // Two properties under PUB_A.
      await fedDb.upsertProperty({
        property_id: 'endpoint-home',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Endpoint Home',
        identifiers: [{ type: 'domain', value: PUB_A }],
        tags: ['flagship'],
      });
      await fedDb.upsertProperty({
        property_id: 'endpoint-mobile',
        publisher_domain: PUB_A,
        property_type: 'mobile_app',
        name: 'Endpoint Mobile',
        identifiers: [{ type: 'ios_bundle', value: 'com.endpoint.app' }],
      });
      const props = await fedDb.getPropertiesForDomain(PUB_A);
      const home = props.find((p) => p.name === 'Endpoint Home') as unknown as { id: string };
      const mobile = props.find((p) => p.name === 'Endpoint Mobile') as unknown as { id: string };

      // Discovered agents (so /registry/agents listAllAgents returns them).
      await fedDb.upsertAgent({
        agent_url: AGENT_X,
        source_type: 'adagents_json',
        source_domain: PUB_A,
        agent_type: 'sales',
        protocol: 'mcp',
        name: 'Endpoint Sales X',
      });
      await fedDb.upsertAgent({
        agent_url: AGENT_Y,
        source_type: 'adagents_json',
        source_domain: PUB_B,
        agent_type: 'sales',
        protocol: 'mcp',
        name: 'Endpoint Sales Y',
      });

      // Publisher-level authorizations (drives /registry/publisher and
      // /registry/operator).
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'all',
        source: 'adagents_json',
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_Y,
        publisher_domain: PUB_A,
        source: 'agent_claim',
      });

      // Property-level authorization for AGENT_X on home only (not mobile).
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: home.id,
      });
      // AGENT_Y has property-level auth on mobile only.
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_Y,
        property_id: mobile.id,
      });

      // Discovered publisher row so hasValidAdagents resolves true.
      await fedDb.upsertPublisher({
        domain: PUB_A,
        discovered_by_agent: AGENT_X,
        has_valid_adagents: true,
      });
    });

    // ── /registry/publisher ────────────────────────────────────────

    it('GET /api/registry/publisher returns properties + authorized agents for a seeded domain', async () => {
      const res = await request(app).get(
        `/api/registry/publisher?domain=${encodeURIComponent(PUB_A)}`
      );
      expect(res.status).toBe(200);
      expect(res.body.domain).toBe(PUB_A);
      expect(res.body.adagents_valid).toBe(true);

      // Properties: the route projects {id, type, name, identifiers, tags}.
      const propsByName = new Map(
        res.body.properties.map((p: { name: string }) => [p.name, p])
      );
      expect(propsByName.size).toBe(2);
      expect(propsByName.get('Endpoint Home')).toMatchObject({
        id: 'endpoint-home',
        type: 'website',
        name: 'Endpoint Home',
        identifiers: [{ type: 'domain', value: PUB_A }],
      });
      expect(propsByName.get('Endpoint Mobile')).toMatchObject({
        id: 'endpoint-mobile',
        type: 'mobile_app',
      });

      // Authorized agents: includes both adagents_json and agent_claim
      // sources, projected as {url, authorized_for, source}.
      const agentsByUrl = new Map(
        res.body.authorized_agents.map((a: { url: string }) => [a.url, a])
      );
      expect(agentsByUrl.get(AGENT_X)).toMatchObject({
        url: AGENT_X,
        authorized_for: 'all',
        source: 'adagents_json',
      });
      expect(agentsByUrl.get(AGENT_Y)).toMatchObject({
        url: AGENT_Y,
        source: 'agent_claim',
      });
    });

    // ── /registry/publishers ───────────────────────────────────────

    it('GET /api/registry/publishers includes our seeded publisher with discovered source', async () => {
      const res = await request(app).get('/api/registry/publishers');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.publishers)).toBe(true);
      expect(res.body.sources).toMatchObject({
        registered: expect.any(Number),
        discovered: expect.any(Number),
      });

      const ours = res.body.publishers.find(
        (p: { domain: string }) => p.domain === PUB_A
      );
      expect(ours).toBeTruthy();
      expect(ours.source).toBe('discovered');
      expect(ours.has_valid_adagents).toBe(true);
    });

    // ── /registry/operator ─────────────────────────────────────────

    it('GET /api/registry/operator returns null member when no profile owns the domain', async () => {
      // No member_profile seeded for PUB_A, so the operator endpoint
      // returns the empty agent list (the agents array is sourced from
      // the member profile's agents[], not federated discoveries).
      const res = await request(app).get(
        `/api/registry/operator?domain=${encodeURIComponent(PUB_A)}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        domain: PUB_A,
        member: null,
        agents: [],
      });
    });

    it('GET /api/registry/operator projects the member profile + per-agent authorized_by array', async () => {
      // Seed a profile claiming PUB_A as its primary brand domain. The
      // operator endpoint pulls agents from the profile's public
      // agents[] and enriches each with authorized_by drawn from
      // getAuthorizationsForAgent. PR 4 swaps that reader, so the
      // per-agent projection (publisher_domain, authorized_for, source)
      // is exactly what the cutover must preserve. The seeded fixtures
      // already have AGENT_X authorized to PUB_A via adagents_json.
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
         VALUES ($1, 'Endpoint Baseline Org', NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO NOTHING`,
        [ORG_ID]
      );
      await pool.query(
        `INSERT INTO member_profiles (
           workos_organization_id, display_name, slug,
           agents, primary_brand_domain, is_public,
           created_at, updated_at
         ) VALUES ($1, 'Endpoint Baseline Org', $2, $3::jsonb, $4, true, NOW(), NOW())
         ON CONFLICT (workos_organization_id) DO UPDATE SET
           agents = EXCLUDED.agents,
           primary_brand_domain = EXCLUDED.primary_brand_domain,
           is_public = EXCLUDED.is_public,
           updated_at = NOW()`,
        [
          ORG_ID,
          MEMBER_SLUG,
          JSON.stringify([
            { url: AGENT_X, name: 'Endpoint Sales X', type: 'sales', visibility: 'public' },
          ]),
          PUB_A,
        ]
      );

      const res = await request(app).get(
        `/api/registry/operator?domain=${encodeURIComponent(PUB_A)}`
      );
      expect(res.status).toBe(200);
      expect(res.body.domain).toBe(PUB_A);
      expect(res.body.member).toMatchObject({
        slug: MEMBER_SLUG,
        display_name: 'Endpoint Baseline Org',
      });
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0]).toMatchObject({
        url: AGENT_X,
        name: 'Endpoint Sales X',
        type: 'sales',
      });
      // The authorized_by array shape is what publisher-ops UIs render
      // and what PR 4 must not silently rename or drop.
      expect(Array.isArray(res.body.agents[0].authorized_by)).toBe(true);
      const pubAEntry = res.body.agents[0].authorized_by.find(
        (a: { publisher_domain: string }) => a.publisher_domain === PUB_A
      );
      expect(pubAEntry).toMatchObject({
        publisher_domain: PUB_A,
        authorized_for: 'all',
        source: 'adagents_json',
      });
    });

    // ── /registry/stats ────────────────────────────────────────────

    it('GET /api/registry/stats reflects at least our seeded counts', async () => {
      const res = await request(app).get('/api/registry/stats');
      expect(res.status).toBe(200);
      // Lower-bounds: our seed adds ≥2 agents, ≥1 publisher, ≥2 properties,
      // ≥2 authorizations (one each in adagents_json + agent_claim).
      expect(res.body.discovered_agents).toBeGreaterThanOrEqual(2);
      expect(res.body.discovered_publishers).toBeGreaterThanOrEqual(1);
      expect(res.body.discovered_properties).toBeGreaterThanOrEqual(2);
      expect(res.body.authorizations).toBeGreaterThanOrEqual(2);
      expect(res.body.authorizations_by_source.adagents_json).toBeGreaterThanOrEqual(1);
      expect(res.body.authorizations_by_source.agent_claim).toBeGreaterThanOrEqual(1);
      expect(res.body.properties_by_type.website).toBeGreaterThanOrEqual(1);
      expect(res.body.properties_by_type.mobile_app).toBeGreaterThanOrEqual(1);
    });

    // ── /registry/agents ───────────────────────────────────────────

    it('GET /api/registry/agents includes our seeded agents with full DSP-discovery projection', async () => {
      const res = await request(app).get('/api/registry/agents');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.agents)).toBe(true);
      expect(res.body.sources).toMatchObject({
        registered: expect.any(Number),
        discovered: expect.any(Number),
      });

      const x = res.body.agents.find((a: { url: string }) => a.url === AGENT_X);
      const y = res.body.agents.find((a: { url: string }) => a.url === AGENT_Y);
      expect(x).toBeTruthy();
      expect(y).toBeTruthy();
      expect(x.source).toBe('discovered');
      expect(x.type).toBe('sales');
      expect(x.protocol).toBe('mcp');
      // discovered_from is the DSP-discovery breadcrumb — sourced from
      // the bulk-auth join via discovered_agents.source_domain. PR 4
      // must not drop or rename this field.
      expect(x.discovered_from).toMatchObject({ publisher_domain: PUB_A });
      // added_date is sourced from discovered_at; pin presence as a
      // non-empty string but not an exact value.
      expect(typeof x.added_date).toBe('string');
      expect(x.added_date.length).toBeGreaterThan(0);
    });

    it('GET /api/registry/agents?properties=true enriches buying agents only', async () => {
      // Seed an additional buyer-typed agent so we exercise the
      // properties-enrichment branch. The current readers attach
      // property_summary + publisher_domains for type=buying.
      const BUYER_URL = 'https://endpoint-buyer.registry-baseline.example';
      await fedDb.upsertAgent({
        agent_url: BUYER_URL,
        source_type: 'adagents_json',
        source_domain: PUB_B,
        agent_type: 'buying',
        protocol: 'mcp',
        name: 'Endpoint Buyer',
      });
      // Authorize the buyer on the existing PUB_A home property.
      const props = await fedDb.getPropertiesForDomain(PUB_A);
      const home = props.find((p) => p.name === 'Endpoint Home') as unknown as { id: string };
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: BUYER_URL,
        property_id: home.id,
      });

      const res = await request(app).get('/api/registry/agents?properties=true');
      expect(res.status).toBe(200);

      const buyer = res.body.agents.find((a: { url: string }) => a.url === BUYER_URL);
      expect(buyer).toBeTruthy();
      expect(buyer.publisher_domains).toEqual([PUB_A]);
      expect(buyer.property_summary).toMatchObject({
        total_count: 1,
        publisher_count: 1,
        count_by_type: { website: 1 },
      });

      // Sales-typed agents must NOT receive property enrichment, even
      // when ?properties=true is set.
      const x = res.body.agents.find((a: { url: string }) => a.url === AGENT_X);
      expect(x).toBeTruthy();
      expect(x.publisher_domains).toBeUndefined();
      expect(x.property_summary).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // /registry/feed — change feed smoke test. The feed itself reads
  // catalog_events (not the property/publisher tables under cutover)
  // but is listed in #3177 because cross-instance pollers depend on it
  // staying stable across the migration.
  // ──────────────────────────────────────────────────────────────────

  describe('/registry/feed envelope', () => {
    it('returns events array + has_more flag (auth pass-through under test mock)', async () => {
      const res = await request(app).get('/api/registry/feed?limit=1');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(typeof res.body.has_more).toBe('boolean');
    });

    it('rejects an invalid cursor format with 400', async () => {
      const res = await request(app).get('/api/registry/feed?cursor=not-a-uuid');
      expect(res.status).toBe(400);
    });
  });
});
