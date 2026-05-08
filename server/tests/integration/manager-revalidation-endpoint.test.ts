/**
 * HTTP endpoint test for /api/registry/manager-revalidation-request
 * (#4200 item 5).
 *
 * The endpoint short-circuits the 60-minute organic crawl cycle: when a
 * manager rotates its adagents.json, ops can hit this endpoint and have
 * every delegating publisher enqueued for re-validation immediately.
 * Body of the request is just `{ manager_domain }`; the handler calls
 * `enqueueManagerRevalidation` and returns the count.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// Bypass DNS-based domain validation: test fixtures use `.example.com`
// subdomains that don't resolve in CI. The real validation surface is
// exercised by the publisher crawl-request endpoint tests.
vi.mock('../../src/utils/url-security.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/utils/url-security.js');
  return {
    ...actual,
    validateCrawlDomain: async (domain: string) => domain.toLowerCase().trim(),
  };
});

import request from 'supertest';
import express from 'express';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

const MANAGER = 'mgr-revalidation-endpoint.example.com';
const PUB_A = 'pub-a.mgr-revalidation-endpoint.example.com';
const PUB_B = 'pub-b.mgr-revalidation-endpoint.example.com';

function buildTestApp() {
  const app = express();
  app.use(express.json());

  const passAuth: import('express').RequestHandler = (req, _res, next) => {
    (req as import('express').Request & { user?: { id: string } }).user = { id: 'test-member' };
    next();
  };

  const config: RegistryApiConfig = {
    brandManager: {} as unknown as RegistryApiConfig['brandManager'],
    brandDb: {} as unknown as RegistryApiConfig['brandDb'],
    propertyDb: {} as unknown as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as unknown as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as unknown as RegistryApiConfig['healthChecker'],
    crawler: {} as unknown as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as unknown as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth: passAuth,
    optionalAuth: passAuth,
  };

  const router = createRegistryApiRouter(config);
  app.use('/api', router);
  return app;
}

describe('POST /api/registry/manager-revalidation-request', () => {
  let pool: Pool;
  let app: express.Express;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    app = buildTestApp();
  });

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM manager_revalidation_queue WHERE publisher_domain = ANY($1::text[])`,
      [[PUB_A, PUB_B]],
    );
    await pool.query(
      `DELETE FROM publishers WHERE domain = ANY($1::text[])`,
      [[PUB_A, PUB_B, MANAGER]],
    );
  }

  async function seedDelegatingPublisher(domain: string, manager: string): Promise<void> {
    await pool.query(
      `INSERT INTO publishers (domain, source_type, manager_domain, discovery_method, last_validated)
       VALUES ($1, 'adagents_json', $2, 'ads_txt_managerdomain', NOW())`,
      [domain, manager],
    );
  }

  beforeEach(async () => {
    await clearFixtures();
  });

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  it('enqueues every delegating publisher and returns the count', async () => {
    await seedDelegatingPublisher(PUB_A, MANAGER);
    await seedDelegatingPublisher(PUB_B, MANAGER);

    const res = await request(app)
      .post('/api/registry/manager-revalidation-request')
      .send({ manager_domain: MANAGER });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      message: 'Manager re-validation enqueued',
      manager_domain: MANAGER,
      publishers_enqueued: 2,
    });

    const queued = await pool.query(
      `SELECT publisher_domain FROM manager_revalidation_queue
        WHERE manager_domain = $1 ORDER BY publisher_domain ASC`,
      [MANAGER],
    );
    expect(queued.rows.map(r => r.publisher_domain)).toEqual([PUB_A, PUB_B]);
  });

  it('returns 0 publishers_enqueued when no publisher delegates to the manager', async () => {
    const res = await request(app)
      .post('/api/registry/manager-revalidation-request')
      .send({ manager_domain: 'nobody-delegates-here.example.com' });

    expect(res.status).toBe(202);
    expect(res.body.publishers_enqueued).toBe(0);
  });

  it('400s when manager_domain is missing', async () => {
    const res = await request(app)
      .post('/api/registry/manager-revalidation-request')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('manager_domain');
  });

  it('lower-cases and trims the manager_domain before lookup', async () => {
    await seedDelegatingPublisher(PUB_A, MANAGER);

    const res = await request(app)
      .post('/api/registry/manager-revalidation-request')
      .send({ manager_domain: `  ${MANAGER.toUpperCase()}  ` });

    expect(res.status).toBe(202);
    expect(res.body.manager_domain).toBe(MANAGER);
    expect(res.body.publishers_enqueued).toBe(1);
  });

  it('rate-limits a second request to the same manager within the window', async () => {
    await seedDelegatingPublisher(PUB_A, MANAGER);

    const first = await request(app)
      .post('/api/registry/manager-revalidation-request')
      .send({ manager_domain: MANAGER });
    expect(first.status).toBe(202);

    const second = await request(app)
      .post('/api/registry/manager-revalidation-request')
      .send({ manager_domain: MANAGER });
    expect(second.status).toBe(429);
    expect(second.body.retry_after).toBeGreaterThan(0);
  });
});
