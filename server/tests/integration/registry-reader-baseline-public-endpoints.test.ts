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

// Set WorkOS env before vi.mock factories run — auth.ts constructs WorkOS
// at module load and the factory's vi.importActual triggers that load.
// Hoisted block runs before mock factories regardless of file ordering.
vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

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
      // sources, projected as {url, authorized_for, source}. Each agent
      // also carries a per-publisher rollup of property authorization.
      const agentsByUrl = new Map(
        res.body.authorized_agents.map((a: { url: string }) => [a.url, a])
      );
      // AGENT_X: property-level row exists for `home` only → 1 of 2.
      expect(agentsByUrl.get(AGENT_X)).toMatchObject({
        url: AGENT_X,
        authorized_for: 'all',
        source: 'adagents_json',
        properties_authorized: 1,
        properties_total: 2,
        publisher_wide: false,
      });
      // AGENT_Y: property-level row exists for `mobile` only → 1 of 2.
      expect(agentsByUrl.get(AGENT_Y)).toMatchObject({
        url: AGENT_Y,
        source: 'agent_claim',
        properties_authorized: 1,
        properties_total: 2,
        publisher_wide: false,
      });
    });

    it('GET /api/registry/publisher reports publisher-wide auth as N of N', async () => {
      // Drop AGENT_X's property-level row so only the publisher-wide
      // authorization remains. The rollup should collapse to "all".
      await pool.query(
        `DELETE FROM agent_property_authorizations
         WHERE agent_url = $1
           AND property_id IN (
             SELECT id FROM discovered_properties WHERE publisher_domain = $2
           )`,
        [AGENT_X, PUB_A]
      );

      const res = await request(app).get(
        `/api/registry/publisher?domain=${encodeURIComponent(PUB_A)}`
      );
      expect(res.status).toBe(200);
      const agentsByUrl = new Map(
        res.body.authorized_agents.map((a: { url: string }) => [a.url, a])
      );
      expect(agentsByUrl.get(AGENT_X)).toMatchObject({
        url: AGENT_X,
        properties_authorized: 2,
        properties_total: 2,
        publisher_wide: true,
      });
    });

    // ── /registry/publisher/authorization ──────────────────────────

    it('GET /api/registry/publisher/authorization returns the per-property breakdown', async () => {
      const res = await request(app).get(
        `/api/registry/publisher/authorization?domain=${encodeURIComponent(PUB_A)}&agent=${encodeURIComponent(AGENT_X)}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        publisher_domain: PUB_A,
        agent_url: AGENT_X,
        authorized: 1,
        total: 2,
        publisher_wide: false,
        source: 'adagents_json',
      });
      expect(res.body.unauthorized_properties).toHaveLength(1);
      expect(res.body.unauthorized_properties[0]).toMatchObject({
        name: 'Endpoint Mobile',
      });
    });

    it('GET /api/registry/publisher/authorization reports publisher-wide as N of N with no unauthorized list', async () => {
      // Drop AGENT_X's property-level row → only publisher-wide remains.
      await pool.query(
        `DELETE FROM agent_property_authorizations
         WHERE agent_url = $1
           AND property_id IN (
             SELECT id FROM discovered_properties WHERE publisher_domain = $2
           )`,
        [AGENT_X, PUB_A]
      );

      const res = await request(app).get(
        `/api/registry/publisher/authorization?domain=${encodeURIComponent(PUB_A)}&agent=${encodeURIComponent(AGENT_X)}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        authorized: 2,
        total: 2,
        publisher_wide: true,
        unauthorized_properties: [],
      });
    });

    it('GET /api/registry/publisher/authorization 404s when the agent is not authorized', async () => {
      const res = await request(app).get(
        `/api/registry/publisher/authorization?domain=${encodeURIComponent(PUB_A)}&agent=${encodeURIComponent('https://unknown-agent.example')}`
      );
      expect(res.status).toBe(404);
    });

    it('GET /api/registry/publisher/authorization returns 400 when params are missing', async () => {
      const res = await request(app).get(
        `/api/registry/publisher/authorization?domain=${encodeURIComponent(PUB_A)}`
      );
      expect(res.status).toBe(400);
    });

    it('GET /api/registry/publisher/authorization tolerates trailing slash on agent URL', async () => {
      const res = await request(app).get(
        `/api/registry/publisher/authorization?domain=${encodeURIComponent(PUB_A)}&agent=${encodeURIComponent(AGENT_X + '/')}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ publisher_domain: PUB_A, authorized: 1, total: 2 });
    });

    // ── /registry/publishers ───────────────────────────────────────

    it('GET /api/registry/publishers does not surface crawler-only publishers', async () => {
      // Registry contains only publishers that members have explicitly
      // enrolled. PUB_A in this fixture exists only in the crawler graph
      // (discovered_publishers), so it must not appear in the public list.
      const res = await request(app).get('/api/registry/publishers');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.publishers)).toBe(true);
      expect(res.body.sources).toBeUndefined();

      const ours = res.body.publishers.find(
        (p: { domain: string }) => p.domain === PUB_A
      );
      expect(ours).toBeUndefined();
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

    it('GET /api/registry/stats reflects at least our seeded auth-graph counts', async () => {
      const res = await request(app).get('/api/registry/stats');
      expect(res.status).toBe(200);
      // The publisher-authorization graph still tracks the underlying
      // authorizations and properties — surfaced under `auth_graph_*`.
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

    it('GET /api/registry/agents?source=registered returns 400 (param removed, not deprecated)', async () => {
      // The `?source=` filter is gone (#3772). Reject explicitly so a caller
      // passing `?source=discovered` doesn't silently get the registered-only
      // set — that's correct-by-coincidence on the registered case and
      // wrong-by-coincidence on the discovered case.
      const registered = await request(app).get('/api/registry/agents?source=registered');
      expect(registered.status).toBe(400);
      expect(registered.body.error).toMatch(/source/i);

      const discovered = await request(app).get('/api/registry/agents?source=discovered');
      expect(discovered.status).toBe(400);
      expect(discovered.body.error).toMatch(/source/i);

      const bogus = await request(app).get('/api/registry/agents?source=anything');
      expect(bogus.status).toBe(400);
    });

    it('GET /api/registry/agents surfaces registered agents and excludes crawler-only agents', async () => {
      // Pins both halves of the registered-only contract:
      //   1. registered agents (member-enrolled) DO appear with member metadata,
      //   2. crawler-only agents (in discovered_agents but not on any member
      //      profile) do NOT appear.
      // Without the positive case a future bug that makes listAllAgents return
      // [] unconditionally would still pass — the negative-only assertion is
      // true-by-default when the catalog is empty.
      const REGISTERED_URL = `${AGENT_PREFIX}registered.registry-baseline.example`;
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
            { url: REGISTERED_URL, name: 'Endpoint Registered', type: 'sales', visibility: 'public' },
          ]),
          PUB_A,
        ]
      );

      const res = await request(app).get('/api/registry/agents');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.agents)).toBe(true);
      expect(res.body.sources).toBeUndefined();

      // Positive: member-enrolled agent surfaces with the member ref.
      const registered = res.body.agents.find(
        (a: { url: string }) => a.url === REGISTERED_URL,
      );
      expect(registered).toBeTruthy();
      expect(registered.member).toMatchObject({
        slug: MEMBER_SLUG,
        display_name: 'Endpoint Baseline Org',
      });
      // `added_date` is dropped from the projection — we have no real
      // enrollment-date source on the wire today, so the field is omitted
      // rather than stamped with `today`.
      expect(registered.added_date).toBeUndefined();

      // Negative: crawler-only agents (seeded in discovered_agents only)
      // must not appear.
      const x = res.body.agents.find((a: { url: string }) => a.url === AGENT_X);
      const y = res.body.agents.find((a: { url: string }) => a.url === AGENT_Y);
      expect(x).toBeUndefined();
      expect(y).toBeUndefined();
    });

    it('GET /api/registry/agents?properties=true does not surface crawler-only agents', async () => {
      // The registered-only registry surface excludes agents that exist
      // only in the crawler graph regardless of enrichment flags.
      const res = await request(app).get('/api/registry/agents?properties=true');
      expect(res.status).toBe(200);

      const x = res.body.agents.find((a: { url: string }) => a.url === AGENT_X);
      const y = res.body.agents.find((a: { url: string }) => a.url === AGENT_Y);
      expect(x).toBeUndefined();
      expect(y).toBeUndefined();
    });

    it('GET /api/registry/agents?properties=true enriches sales agents only (#3540 polarity)', async () => {
      // Pins the #3540 invariant against the registered-only surface
      // (refs #3538 Problem 1b). Enrichment runs on `type='sales'` — the
      // agents that hold publisher authorizations and call
      // list_authorized_properties. Pre-#3540 the readers filtered on
      // `type='buying'` (an inverted-but-aligned bug from #3495). The
      // discovered-agent removal must not silently drop this polarity
      // assertion: a future refactor that re-introduces the inversion
      // would otherwise skate through CI green.
      //
      // Both agents are registered on the same member profile. Property
      // authorizations on the auth-graph tables (agent_property_
      // authorizations × discovered_properties) drive the enrichment;
      // those rows are seeded by the outer beforeEach. AGENT_X is
      // registered as sales, AGENT_Y as buying — same fixtures, opposite
      // polarity.
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
            { url: AGENT_Y, name: 'Endpoint Buyer Y', type: 'buying', visibility: 'public' },
          ]),
          PUB_A,
        ]
      );

      const res = await request(app).get('/api/registry/agents?properties=true');
      expect(res.status).toBe(200);

      // Sales agent: enriched. AGENT_X has property auth on PUB_A's
      // home property, so publisher_domains and property_summary are
      // populated.
      const x = res.body.agents.find((a: { url: string }) => a.url === AGENT_X);
      expect(x).toBeTruthy();
      expect(x.type).toBe('sales');
      expect(x.publisher_domains).toEqual([PUB_A]);
      expect(x.property_summary).toMatchObject({
        total_count: 1,
        count_by_type: { website: 1 },
      });

      // Buying-typed agents must NOT receive property enrichment, even
      // when ?properties=true is set and even when the agent has rows
      // in agent_property_authorizations. This is the inversion fix in
      // #3540 — the polarity that must hold across the discovered-agent
      // removal.
      const y = res.body.agents.find((a: { url: string }) => a.url === AGENT_Y);
      expect(y).toBeTruthy();
      expect(y.type).toBe('buying');
      expect(y.publisher_domains).toBeUndefined();
      expect(y.property_summary).toBeUndefined();
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
