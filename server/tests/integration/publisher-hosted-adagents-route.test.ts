/**
 * Integration coverage for AAO-hosted /.well-known/adagents.json. A
 * publisher who opts into AAO hosting can either paste a snippet at their
 * own /.well-known path or point a CNAME / redirect at AAO's hosted URL.
 * This route serves the canonical document for the latter case.
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
    req.user = { id: 'user_test_hosted_adagents', email: 'hosted-adagents@test.com' };
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

const PUB_PUBLIC = 'hosted-adagents-public.registry-baseline.example';
const PUB_PRIVATE = 'hosted-adagents-private.registry-baseline.example';
const DOMAIN_LIKE = 'hosted-adagents-%.registry-baseline.example';

describe('AAO-hosted /publisher/{domain}/.well-known/adagents.json', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
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

  it('serves the hosted adagents.json when is_public=true', async () => {
    const adagents = {
      authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'all' }],
      properties: [{ type: 'website', name: PUB_PUBLIC }],
      contact: { name: 'Ops', email: 'ops@example.com' },
    };
    await propertyDb.createHostedProperty({
      publisher_domain: PUB_PUBLIC,
      adagents_json: adagents,
      is_public: true,
      source_type: 'community',
    });

    const res = await request(app).get(
      `/publisher/${encodeURIComponent(PUB_PUBLIC)}/.well-known/adagents.json`
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body).toEqual(adagents);
  });

  it('returns 404 when the hosted property exists but is_public=false', async () => {
    await propertyDb.createHostedProperty({
      publisher_domain: PUB_PRIVATE,
      adagents_json: { authorized_agents: [], properties: [] },
      is_public: false,
      source_type: 'community',
    });

    const res = await request(app).get(
      `/publisher/${encodeURIComponent(PUB_PRIVATE)}/.well-known/adagents.json`
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when no hosted property exists for the domain', async () => {
    const res = await request(app).get(
      `/publisher/${encodeURIComponent(PUB_PUBLIC)}/.well-known/adagents.json`
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for syntactically invalid domain input', async () => {
    const res = await request(app).get(
      `/publisher/${encodeURIComponent('not a domain!')}/.well-known/adagents.json`
    );
    expect(res.status).toBe(400);
  });
});
