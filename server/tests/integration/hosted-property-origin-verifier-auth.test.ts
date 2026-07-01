/**
 * Auth-gate coverage for the verify-origin endpoint, exercised with a
 * NON-admin authenticated caller. Lives in its own file because the
 * sibling `hosted-property-origin-verifier.test.ts` mocks auth as
 * admin (so the verifier round-trip can be exercised without the
 * fail-closed gate kicking in). vi.mock is per-file, so a non-admin
 * test needs its own file.
 *
 * Squatting risk being guarded:
 *   `/api/properties/save` allows any authenticated caller to create
 *   a hosted_properties row for any publisher_domain. Under bind-on-verify,
 *   triggering verify-origin is open to any authenticated caller (binding is
 *   driven by the `adcp_claim` token in the publisher's origin pointer, not by
 *   the caller). The invariant these tests guard is that triggering
 *   verification can never bind/rebind an owner without a matching pending
 *   claim — so a squatter who can't make the origin point at their token can
 *   never seize a domain, and an existing owner is never overwritten.
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
    req.user = { id: 'user_nonadmin', email: 'nonadmin@test.com', isAdmin: false };
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

const PUB = 'origin-verifier-nonadmin.registry-baseline.example';
const DOMAIN_LIKE = 'origin-verifier-nonadmin.%';

describe('verify-origin endpoint — non-admin auth (squat prevention)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let propertyDb: PropertyDatabase;

  const OTHER_ORG_ID = 'org_squat_test_someone_else';

  async function clearFixtures() {
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [OTHER_ORG_ID]);
  }

  async function seedOtherOrg(): Promise<void> {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name)
       VALUES ($1, $2)
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [OTHER_ORG_ID, 'Other Org (squat-test)'],
    );
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

  it('does not bind an owner when verify-origin is triggered on an unclaimed row (squat prevention)', async () => {
    // Mirror the create path used by /api/properties/save: NULL owner, no pending claim.
    await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [], properties: [] },
      is_public: true,
      source_type: 'community',
      // workos_organization_id intentionally omitted
    });

    // Triggering verification is no longer gated on caller ownership (binding is
    // driven by the claim token in the origin pointer, not the caller). But with
    // no pending claim, no origin outcome can bind an owner. The fake .example
    // origin is unresolvable → verified:false.
    const res = await request(app)
      .post(`/api/properties/hosted/${encodeURIComponent(PUB)}/verify-origin`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);

    // The invariant that matters: no squat-driven binding.
    const row = await propertyDb.getHostedPropertyByDomain(PUB);
    expect(row!.workos_organization_id ?? null).toBeNull();
  });

  it('a non-owner trigger never changes the bound owner (the lock holds)', async () => {
    await seedOtherOrg();
    await propertyDb.createHostedProperty({
      publisher_domain: PUB,
      adagents_json: { authorized_agents: [], properties: [] },
      is_public: true,
      source_type: 'community',
      workos_organization_id: OTHER_ORG_ID,
    });

    const res = await request(app)
      .post(`/api/properties/hosted/${encodeURIComponent(PUB)}/verify-origin`)
      .send({});
    // The caller-org gate is gone — triggering is allowed...
    expect(res.status).toBe(200);
    // ...but it cannot rebind: ownership is unchanged.
    const row = await propertyDb.getHostedPropertyByDomain(PUB);
    expect(row!.workos_organization_id).toBe(OTHER_ORG_ID);
  });
});
