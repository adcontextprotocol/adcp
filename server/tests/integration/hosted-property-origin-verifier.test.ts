/**
 * Integration coverage for the hosted-property origin verifier and the
 * promotion of aao_hosted → adagents_json on successful verification.
 *
 * Uses a mocked publisher-origin fetch (so we don't actually hit a
 * domain) but exercises the full DB round-trip: hosted property →
 * sync writes aao_hosted rows → verifier promotes them → reading
 * /api/registry/publisher reflects source='adagents_json'.
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
    req.user = { id: 'user_origin_verifier', email: 'origin-verifier@test.com', isAdmin: true };
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
import { syncHostedPropertyToFederatedIndex } from '../../src/services/hosted-property-sync.js';
import { verifyHostedPropertyOrigin } from '../../src/services/hosted-property-origin-verifier.js';
import { aaoHostedAdagentsJsonUrl } from '../../src/config/aao.js';

const PUB = 'origin-verifier-pub.registry-baseline.example';
const AGENT = 'https://agent.origin-verifier.registry-baseline.example';
const AGENT_OTHER = 'https://other-agent.origin-verifier.registry-baseline.example';
const DOMAIN_LIKE = 'origin-verifier-%.registry-baseline.example';
const AGENT_LIKE = 'https://%-agent.origin-verifier.registry-baseline.example';

describe('hosted-property origin verifier', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_publisher_authorizations WHERE publisher_domain LIKE $1 OR agent_url LIKE $2`,
      [DOMAIN_LIKE, AGENT_LIKE],
    );
    await pool.query('DELETE FROM discovered_agents WHERE agent_url LIKE $1', [AGENT_LIKE]);
    await pool.query('DELETE FROM discovered_publishers WHERE domain LIKE $1', [DOMAIN_LIKE]);
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

  it('promotes aao_hosted → adagents_json when publisher origin returns matching authoritative_location stub', async () => {
    const adagents = {
      authorized_agents: [{ url: AGENT, authorized_for: 'all' }],
      properties: [{ type: 'website', name: PUB }],
    };
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: adagents,
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    // Pre-state: row is aao_hosted.
    let res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    expect(res.body.authorized_agents[0].source).toBe('aao_hosted');

    // Mock the publisher's /.well-known/adagents.json — returns a stub
    // pointing at AAO's hosted URL.
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        authoritative_location: aaoHostedAdagentsJsonUrl(PUB),
      }),
    });

    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl,
    });
    expect(outcome.verified).toBe(true);
    if (outcome.verified) expect(outcome.reason).toBe('authoritative_location_pointer');

    // Post-state: row promoted to adagents_json. Hosting block surfaces
    // origin_verified_at.
    res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    expect(res.body.authorized_agents[0].source).toBe('adagents_json');
    expect(res.body.hosting.origin_verified_at).toBeTruthy();
    expect(res.body.hosting.origin_last_checked_at).toBeTruthy();
  });

  it('does NOT promote when publisher origin returns 404', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [{ url: AGENT }], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    const fetchImpl = vi.fn().mockResolvedValue({ status: 404, body: '' });
    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl,
    });
    expect(outcome.verified).toBe(false);
    if (!outcome.verified) expect(outcome.reason).toBe('not_found');

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    expect(res.body.authorized_agents[0].source).toBe('aao_hosted');
    expect(res.body.hosting.origin_verified_at).toBeNull();
    expect(res.body.hosting.origin_last_checked_at).toBeTruthy();
  });

  it('treats 5xx as transient (does not demote, stamps last_checked)', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [{ url: AGENT }], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    // First, succeed — establish a verified state.
    const ok = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        authoritative_location: aaoHostedAdagentsJsonUrl(PUB),
      }),
    });
    await verifyHostedPropertyOrigin({ hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!, fetchImpl: ok });

    // Now a 503 — must NOT demote (spec mandates 7-day cap on transient failures).
    const fail = vi.fn().mockResolvedValue({ status: 503, body: 'Service Unavailable' });
    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: fail,
    });
    expect(outcome.verified).toBe(false);
    if (!outcome.verified) expect(outcome.reason).toBe('transient');

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    // Source remains promoted; verification is unchanged.
    expect(res.body.authorized_agents[0].source).toBe('adagents_json');
    expect(res.body.hosting.origin_verified_at).toBeTruthy();
    expect(res.body.hosting.origin_last_checked_at).toBeTruthy();
  });

  it('does NOT promote when authoritative_location points elsewhere', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [{ url: AGENT }], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ authoritative_location: 'https://attacker.example/adagents.json' }),
    });
    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl,
    });
    expect(outcome.verified).toBe(false);
    if (!outcome.verified) expect(outcome.reason).toBe('authoritative_location_mismatch');

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    expect(res.body.authorized_agents[0].source).toBe('aao_hosted');
  });

  it('does NOT verify via document echo (path was dropped on protocol review)', async () => {
    const adagents = {
      authorized_agents: [{ url: AGENT, authorized_for: 'all' }],
      properties: [{ type: 'website', name: PUB }],
    };
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: adagents,
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    // Publisher serves an inline copy (matching authorized_agents set,
    // no authoritative_location). The previous "document echo"
    // heuristic accepted this; spec says only the stub pattern is
    // valid, so we now reject and emit `no_authoritative_location`.
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify(adagents) });
    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl,
    });
    expect(outcome.verified).toBe(false);
    if (!outcome.verified) expect(outcome.reason).toBe('no_authoritative_location');
  });

  it('demotes adagents_json → aao_hosted when verification fails after a previous success', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [{ url: AGENT }], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    // First verification: success.
    const okFetch = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        authoritative_location: aaoHostedAdagentsJsonUrl(PUB),
      }),
    });
    await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: okFetch,
    });
    let res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    expect(res.body.authorized_agents[0].source).toBe('adagents_json');

    // Second verification: publisher removed the stub — origin returns 404.
    const failFetch = vi.fn().mockResolvedValue({ status: 404, body: '' });
    await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: failFetch,
    });
    res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    expect(res.body.authorized_agents[0].source).toBe('aao_hosted');
    expect(res.body.hosting.origin_verified_at).toBeNull();
  });

  it('treats network errors as transient (does not change persisted state)', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [{ url: AGENT }], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    const before = await propertyDb.getHostedPropertyByDomain(PUB);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const outcome = await verifyHostedPropertyOrigin({ hosted: before!, fetchImpl });
    expect(outcome.verified).toBe(false);
    if (!outcome.verified) expect(outcome.reason).toBe('transient');

    const after = await propertyDb.getHostedPropertyByDomain(PUB);
    // origin_verified_at is preserved across transient errors — a
    // network blip MUST NOT flip a previously-verified row. But
    // origin_last_checked_at IS stamped so the UI can show "checked
    // X minutes ago" honestly even when the result was transient.
    expect(after?.origin_verified_at ?? null).toEqual(before?.origin_verified_at ?? null);
    expect(after?.origin_last_checked_at).toBeTruthy();
    if (before?.origin_last_checked_at) {
      expect(after!.origin_last_checked_at!.getTime())
        .toBeGreaterThanOrEqual(before.origin_last_checked_at.getTime());
    }
  });

  it('classifies DNS NXDOMAIN as permanent unresolvable, demotes if previously verified', async () => {
    const hosted = await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [{ url: AGENT }], properties: [] },
      is_public: true,
      source_type: 'community',
    });
    await syncHostedPropertyToFederatedIndex(hosted);

    // Establish a verified state first.
    const ok = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ authoritative_location: aaoHostedAdagentsJsonUrl(PUB) }),
    });
    await verifyHostedPropertyOrigin({ hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!, fetchImpl: ok });

    // Now NXDOMAIN — safeFetch surfaces this as an Error whose message
    // contains "ENOTFOUND" / "EAI_". Verifier classifies as permanent
    // and demotes.
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND foo'), { code: 'ENOTFOUND' }));
    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl,
    });
    expect(outcome.verified).toBe(false);
    if (!outcome.verified) expect(outcome.reason).toBe('unresolvable');

    const res = await request(app).get(`/api/registry/publisher?domain=${encodeURIComponent(PUB)}`);
    expect(res.body.authorized_agents[0].source).toBe('aao_hosted');
    expect(res.body.hosting.origin_verified_at).toBeNull();
  });

  // ── Trigger endpoint ───────────────────────────────────────────

  it('POST /api/properties/hosted/:domain/verify-origin runs the verifier (admin path)', async () => {
    // We can't override fetchImpl through the route, so this test
    // exercises the failure path (the endpoint can't reach the test
    // fixture domain over the network, so safeFetch will fail) — it
    // verifies the endpoint plumbing is wired, returns a structured
    // outcome, and stamps origin_last_checked_at.
    const adagents = { authorized_agents: [{ url: AGENT_OTHER }], properties: [] };
    await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: adagents,
      is_public: true,
      source_type: 'community',
    });

    const res = await request(app)
      .post(`/api/properties/hosted/${encodeURIComponent(PUB)}/verify-origin`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('verified');
    expect(res.body).toHaveProperty('reason');
    expect(res.body).toHaveProperty('checked_at');
    // The endpoint should have stamped checked_at OR returned 'transient'
    // (we can't actually reach the publisher origin in tests).
    expect(['fetch_failed', 'non_200_response', 'transient', 'invalid_json', 'authoritative_location_mismatch', 'no_authoritative_location']).toContain(res.body.reason);
  });

  it('POST /api/properties/hosted/:domain/verify-origin returns 404 when no hosted property exists', async () => {
    const res = await request(app)
      .post(`/api/properties/hosted/${encodeURIComponent('unhosted-' + PUB)}/verify-origin`)
      .send({});
    expect(res.status).toBe(404);
  });
});
