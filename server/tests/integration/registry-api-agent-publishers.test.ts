/**
 * HTTP-level integration tests for the AAO directory inverse-lookup endpoint
 * (adcp#4823), exposed at `/v1/agents/{agent_url}/publishers` with the
 * legacy `/api/v1/agents/{agent_url}/publishers` path kept for compatibility.
 *
 * Focused on route-handler parsing logic (status / cursor / since / limit /
 * ETag / 404 vs 200-empty) that the DB-level integration test
 * (`registry-agent-publishers-detail.test.ts`) doesn't exercise. The DB
 * test covers the SQL shape; this test covers everything between the wire
 * and the DB call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT_URL = `https://route-${RUN_SUFFIX}.directorytest.example`;
const ABSENT_AGENT_URL = `https://absent-${RUN_SUFFIX}.directorytest.example`;
const PUB_A = `route-a-${RUN_SUFFIX}.directorytest.example`;
const PUB_B = `route-b-${RUN_SUFFIX}.directorytest.example`;
const PUB_REVOKED = `route-revoked-${RUN_SUFFIX}.directorytest.example`;
const ALL_PUBS = [PUB_A, PUB_B, PUB_REVOKED];

describe('GET /v1 and /api/v1 agents/{agent_url}/publishers (HTTP)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE agent_url = ANY($1::text[])`,
      [[AGENT_URL, ABSENT_AGENT_URL]],
    );
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain = ANY($1::text[])', [ALL_PUBS]);
    await pool.query('DELETE FROM agent_publisher_authorizations WHERE agent_url = ANY($1::text[])', [[AGENT_URL, ABSENT_AGENT_URL]]);
    await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [ALL_PUBS]);
    await server?.stop();
    await closeDatabase();
  });

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE agent_url = ANY($1::text[])`,
      [[AGENT_URL, ABSENT_AGENT_URL]],
    );
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain = ANY($1::text[])', [ALL_PUBS]);
    await pool.query('DELETE FROM agent_publisher_authorizations WHERE agent_url = ANY($1::text[])', [[AGENT_URL, ABSENT_AGENT_URL]]);
    await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [ALL_PUBS]);
  }

  beforeEach(async () => {
    await clearFixtures();
  });

  async function seedAuthorized(domain: string) {
    await pool.query(
      `INSERT INTO publishers (domain, adagents_json, source_type, domain_verified, last_validated, discovery_method)
       VALUES ($1, $2::jsonb, 'adagents_json', true, NOW(), 'direct')`,
      [domain, JSON.stringify({ authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] })],
    );
    await pool.query(
      `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source, discovered_at, last_validated)
       VALUES ($1, $2, 'adagents_json', NOW(), NOW())`,
      [AGENT_URL, domain],
    );
  }

  async function seedRevoked(domain: string) {
    await pool.query(
      `INSERT INTO publishers (domain, adagents_json, source_type, domain_verified, last_validated, discovery_method)
       VALUES ($1, $2::jsonb, 'adagents_json', true, NOW(), 'direct')`,
      [
        domain,
        JSON.stringify({
          authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }],
          revoked_publisher_domains: [{ publisher_domain: domain, revoked_at: '2026-05-01T00:00:00Z' }],
        }),
      ],
    );
    await pool.query(
      `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source, discovered_at, last_validated)
       VALUES ($1, $2, 'adagents_json', NOW(), NOW())`,
      [AGENT_URL, domain],
    );
  }

  const url = (agentUrl: string, qs = '') =>
    `/api/v1/agents/${encodeURIComponent(agentUrl)}/publishers${qs}`;
  const specUrl = (agentUrl: string, qs = '') =>
    `/v1/agents/${encodeURIComponent(agentUrl)}/publishers${qs}`;

  it('returns 404 for an agent never indexed', async () => {
    const res = await request(app).get(url(ABSENT_AGENT_URL));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ agent_url: expect.any(String) });
  });

  it('returns 200 with publishers for an indexed agent', async () => {
    await seedAuthorized(PUB_A);
    const res = await request(app).get(url(AGENT_URL));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agent_url: expect.any(String),
      directory_indexed_at: expect.any(String),
      publishers: expect.arrayContaining([
        expect.objectContaining({
          publisher_domain: PUB_A,
          discovery_method: 'direct',
          status: 'authorized',
        }),
      ]),
      next_cursor: null,
    });
  });

  it('serves the spec-conformant /v1 path alias', async () => {
    await seedAuthorized(PUB_A);
    const res = await request(app).get(specUrl(AGENT_URL));
    expect(res.status).toBe(200);
    expect(res.body.publishers).toEqual([
      expect.objectContaining({
        publisher_domain: PUB_A,
        status: 'authorized',
      }),
    ]);
  });

  it('returns 200 + empty (not 404) when filters exclude all rows', async () => {
    await seedAuthorized(PUB_A);
    // Filter to only `revoked` — there are none, but the agent IS indexed.
    const res = await request(app).get(url(AGENT_URL, '?status=revoked'));
    expect(res.status).toBe(200);
    expect(res.body.publishers).toEqual([]);
    expect(res.body.directory_indexed_at).toBeNull();
  });

  it('rejects malformed percent-encoding with 400', async () => {
    // %E0%A4 is a malformed UTF-8 sequence; decodeURIComponent throws.
    const res = await request(app).get('/api/v1/agents/%E0%A4/publishers');
    expect(res.status).toBe(400);
  });

  it('rejects invalid status values with 400', async () => {
    const res = await request(app).get(url(AGENT_URL, '?status=banned'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  it('rejects invalid since with 400', async () => {
    const res = await request(app).get(url(AGENT_URL, '?since=not-a-date'));
    expect(res.status).toBe(400);
  });

  it('rejects invalid cursor with 400', async () => {
    // Cursor with embedded control character (after base64url decode).
    const cursor = Buffer.from('foobar', 'utf8').toString('base64url');
    const res = await request(app).get(url(AGENT_URL, `?cursor=${cursor}`));
    expect(res.status).toBe(400);
  });

  it('honors ETag with 304 on If-None-Match', async () => {
    await seedAuthorized(PUB_A);
    const first = await request(app).get(url(AGENT_URL));
    expect(first.status).toBe(200);
    const etag = first.headers['etag'];
    expect(etag).toBeTruthy();
    const second = await request(app).get(url(AGENT_URL)).set('If-None-Match', etag);
    expect(second.status).toBe(304);
  });

  it('paginates via opaque cursor', async () => {
    await seedAuthorized(PUB_A);
    await seedAuthorized(PUB_B);
    const sorted = [PUB_A, PUB_B].sort();

    const page1 = await request(app).get(url(AGENT_URL, '?limit=1'));
    expect(page1.status).toBe(200);
    expect(page1.body.publishers).toHaveLength(1);
    expect(page1.body.publishers[0].publisher_domain).toBe(sorted[0]);
    expect(page1.body.next_cursor).toBeTruthy();

    const page2 = await request(app).get(url(AGENT_URL, `?limit=1&cursor=${page1.body.next_cursor}`));
    expect(page2.status).toBe(200);
    expect(page2.body.publishers).toHaveLength(1);
    expect(page2.body.publishers[0].publisher_domain).toBe(sorted[1]);
    expect(page2.body.next_cursor).toBeNull();
  });

  it('surfaces revoked rows when status=revoked is repeated alongside authorized', async () => {
    await seedRevoked(PUB_REVOKED);
    await seedAuthorized(PUB_A);

    const defaultRes = await request(app).get(url(AGENT_URL));
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.publishers.map((p: { publisher_domain: string }) => p.publisher_domain)).toEqual([PUB_A]);

    const bothRes = await request(app).get(url(AGENT_URL, '?status=authorized&status=revoked'));
    expect(bothRes.status).toBe(200);
    const domains = bothRes.body.publishers.map((p: { publisher_domain: string }) => p.publisher_domain).sort();
    expect(domains).toEqual([PUB_A, PUB_REVOKED].sort());
  });

  it('rejects the comma-separated status form with 400 (per #4858 spec)', async () => {
    const res = await request(app).get(url(AGENT_URL, '?status=authorized,revoked'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/repeat the key/i);
  });
});
