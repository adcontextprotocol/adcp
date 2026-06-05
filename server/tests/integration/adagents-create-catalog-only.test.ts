/**
 * POST /api/adagents/create must accept a catalog-only community mirror.
 *
 * A community mirror for a platform that has not adopted AdCP publishes catalog
 * content (formats/properties/placements) but has no sales agent to authorize,
 * so `authorized_agents` is `[]` — the exact shape the SDK's
 * buildCommunityMirrorAdagents() emits. The route previously rejected it with a
 * blanket "At least one authorized agent is required" 400.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
    req.user = { id: 'user_test_adagents_create', email: 'adagents-create@test.com' };
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

const MINIMAL_PROPERTY = {
  property_id: 'example_site',
  property_type: 'website',
  name: 'Example Site',
  identifiers: [{ type: 'domain', value: 'example.com' }],
  publisher_domain: 'example.com',
};

describe('POST /api/adagents/create — catalog-only community mirror', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    await server.start(0);
    app = (server as unknown as { app: unknown }).app;
  });

  afterAll(async () => {
    await server?.stop();
    await closeDatabase();
  });

  it('generates a catalog-only mirror with authorized_agents:[] when catalog content is present', async () => {
    const res = await request(app)
      .post('/api/adagents/create')
      .send({
        authorized_agents: [],
        catalog_etag: 'example-2026-06-04',
        properties: [MINIMAL_PROPERTY],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // adagents_json is returned as a serialized JSON string.
    const generated = JSON.parse(res.body.data.adagents_json);
    expect(generated.authorized_agents).toEqual([]);
    expect(generated.catalog_etag).toBe('example-2026-06-04');
    expect(Array.isArray(generated.properties)).toBe(true);
  });

  it('rejects an empty authorized_agents array when there is no catalog content', async () => {
    const res = await request(app)
      .post('/api/adagents/create')
      .send({ authorized_agents: [] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/catalog-only community mirror/i);
  });

  it('still generates a normal file with >=1 authorized agent (regression)', async () => {
    const res = await request(app)
      .post('/api/adagents/create')
      .send({
        authorized_agents: [
          {
            url: 'https://agent.example.com',
            authorized_for: 'All properties',
            authorization_type: 'property_tags',
            property_tags: ['all'],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const generated = JSON.parse(res.body.data.adagents_json);
    expect(generated.authorized_agents).toHaveLength(1);
  });
});
