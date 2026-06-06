/**
 * Community-mirror catalog lifecycle (#2176): publish (idempotent), read one,
 * list, and serve at /translated/<platform>/adagents.json.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

// Mutable identity for the authenticated caller so a re-publish can come from a
// different user (used to assert created_by_* is preserved).
const authState = vi.hoisted(() => ({ userId: 'user_test_mirrors', email: 'mirrors@test.com' }));

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: authState.userId, email: authState.email };
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

// Publish gate dependencies. Defaults set in beforeEach.
const isRegistryModerator = vi.hoisted(() => vi.fn());
const isWebUserAAOAdmin = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/brand-logo-auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/services/brand-logo-auth.js');
  return { ...actual, isRegistryModerator };
});
vi.mock('../../src/addie/admin-status-lookup.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/addie/admin-status-lookup.js');
  return { ...actual, isWebUserAAOAdmin };
});

import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';

const PLATFORM = 'test-meta';
const PLATFORM_LIKE = 'test-%';
const PUBLISHER_DOMAIN = 'community-mirror-test.example';
const REMOVED_PUBLISHER_DOMAIN = 'removed-community-mirror-test.example';
const TEST_DATABASE_URL = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';

const MINIMAL_PROPERTY = {
  property_id: 'instagram',
  property_type: 'mobile_app',
  name: 'Instagram',
  identifiers: [{ type: 'domain', value: PUBLISHER_DOMAIN }],
  publisher_domain: PUBLISHER_DOMAIN,
};
const REMOVED_PROPERTY = {
  property_id: 'threads',
  property_type: 'website',
  name: 'Threads',
  identifiers: [{ type: 'domain', value: REMOVED_PUBLISHER_DOMAIN }],
  publisher_domain: REMOVED_PUBLISHER_DOMAIN,
};
// A valid ProductFormatDeclaration: format_kind + params are both required.
const MINIMAL_FORMAT = {
  format_option_id: 'meta_feed_image',
  display_name: 'Meta Feed Image',
  format_kind: 'image',
  params: { width: 1080, height: 1080 },
};

function publishBody(overrides: Record<string, unknown> = {}) {
  return {
    catalog_etag: 'test-etag-1',
    properties: [MINIMAL_PROPERTY],
    formats: [MINIMAL_FORMAT],
    ...overrides,
  };
}

describe('Community-mirror lifecycle — /api/registry/mirrors + /translated', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let publisherDb: PublisherDatabase;
  let federatedDb: FederatedIndexDatabase;

  async function clear() {
    await pool.query(
      `DELETE FROM catalog_identifiers ci
        WHERE ci.property_rid IN (
          SELECT cp.property_rid
            FROM catalog_properties cp
           WHERE cp.created_by = $1
        )`,
      [`community_adagents:${PLATFORM}`],
    );
    await pool.query('DELETE FROM catalog_properties WHERE created_by = $1', [`community_adagents:${PLATFORM}`]);
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain = ANY($1::text[])', [[PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]]);
    await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [[PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]]);
    await pool.query('DELETE FROM community_mirrors WHERE platform LIKE $1', [PLATFORM_LIKE]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = initializeDatabase({
      connectionString: TEST_DATABASE_URL,
    });
    await runMigrations();
    server = new HTTPServer();
    publisherDb = new PublisherDatabase();
    federatedDb = new FederatedIndexDatabase();
    await server.start(0);
    app = (server as unknown as { app: unknown }).app;
  });

  afterAll(async () => {
    await clear();
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    isRegistryModerator.mockResolvedValue(true);
    isWebUserAAOAdmin.mockResolvedValue(false);
    authState.userId = 'user_test_mirrors';
    authState.email = 'mirrors@test.com';
    await clear();
  });

  it('publishes a catalog-only mirror (authorized_agents forced to [])', async () => {
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.platform).toBe(PLATFORM);
    expect(res.body.catalog_etag).toBe('test-etag-1');
    expect(res.body.publisher_domains).toEqual([PUBLISHER_DOMAIN]);

    const publishers = await pool.query(
      `SELECT source_type, review_status, discovery_method, created_by_user_id, resolved_url, adagents_json
         FROM publishers
        WHERE domain = $1`,
      [PUBLISHER_DOMAIN],
    );
    expect(publishers.rows).toHaveLength(1);
    expect(publishers.rows[0]).toMatchObject({
      source_type: 'community',
      review_status: 'approved',
      discovery_method: 'community_catalog',
      created_by_user_id: `community_adagents:${PLATFORM}`,
      resolved_url: `/api/creative-agent/translated/${PLATFORM}/adagents.json`,
    });
    expect(publishers.rows[0].adagents_json.properties).toHaveLength(1);
    expect(publishers.rows[0].adagents_json.formats).toHaveLength(1);

    const projected = await pool.query(
      `SELECT source_type, property_id, publisher_domain, name
         FROM discovered_properties
        WHERE publisher_domain = $1`,
      [PUBLISHER_DOMAIN],
    );
    expect(projected.rows).toEqual([
      {
        source_type: 'community',
        property_id: 'instagram',
        publisher_domain: PUBLISHER_DOMAIN,
        name: 'Instagram',
      },
    ]);

    const read = await request(app).get(`/api/registry/mirrors/${PLATFORM}`);
    expect(read.status).toBe(200);
    expect(read.body.adagents_json.authorized_agents).toEqual([]);
    expect(read.body.adagents_json.formats).toHaveLength(1);
    expect(read.body.adagents_json.$schema).toMatch(/adagents\.json$/);
  });

  it('drops any caller-supplied authorized_agents', async () => {
    const res = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ authorized_agents: [{ url: 'https://evil.example', authorized_for: 'all' }] }));
    expect(res.status).toBe(200);
    const read = await request(app).get(`/api/registry/mirrors/${PLATFORM}`);
    expect(read.body.adagents_json.authorized_agents).toEqual([]);
  });

  it('allows an AAO admin who is not a registry moderator to publish', async () => {
    isRegistryModerator.mockResolvedValue(false);
    isWebUserAAOAdmin.mockResolvedValue(true);
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status).toBe(200);
  });

  it('re-publish is idempotent — updates in place, no duplicate row', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v1' }));
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v2' }));

    const { rows } = await pool.query('SELECT catalog_etag FROM community_mirrors WHERE platform = $1', [PLATFORM]);
    expect(rows).toHaveLength(1);
    expect(rows[0].catalog_etag).toBe('v2');

    const list = await request(app).get('/api/registry/mirrors');
    const mine = list.body.mirrors.filter((m: { platform: string }) => m.platform === PLATFORM);
    expect(mine).toHaveLength(1);
    expect(mine[0].catalog_etag).toBe('v2');
  });

  it('publishes when property_id collides with an existing differently named property', async () => {
    await pool.query(
      `INSERT INTO discovered_properties
         (property_id, publisher_domain, property_type, name, identifiers, tags, source_type, last_validated)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'adagents_json', NOW())`,
      [
        MINIMAL_PROPERTY.property_id,
        PUBLISHER_DOMAIN,
        'website',
        'First-party Instagram',
        JSON.stringify([{ type: 'domain', value: PUBLISHER_DOMAIN }]),
        ['verified'],
      ],
    );

    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT property_id, publisher_domain, property_type, name, source_type, tags
         FROM discovered_properties
        WHERE publisher_domain = $1
          AND property_id = $2`,
      [PUBLISHER_DOMAIN, MINIMAL_PROPERTY.property_id],
    );
    expect(rows).toEqual([
      {
        property_id: MINIMAL_PROPERTY.property_id,
        publisher_domain: PUBLISHER_DOMAIN,
        property_type: 'website',
        name: 'First-party Instagram',
        source_type: 'adagents_json',
        tags: ['verified'],
      },
    ]);
  });

  it('re-publish replaces the projected publisher rows for that platform', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ properties: [MINIMAL_PROPERTY, REMOVED_PROPERTY] }));
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [REMOVED_PUBLISHER_DOMAIN])).rows).toHaveLength(1);

    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ properties: [MINIMAL_PROPERTY] }));

    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [REMOVED_PUBLISHER_DOMAIN])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM discovered_properties WHERE publisher_domain = $1', [REMOVED_PUBLISHER_DOMAIN])).rows).toHaveLength(0);
  });

  it('preserves created_by_* across a re-publish by a different user', async () => {
    authState.userId = 'creator-A';
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v1' }));
    authState.userId = 'editor-B';
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v2' }));

    const { rows } = await pool.query(
      'SELECT created_by_user_id, catalog_etag FROM community_mirrors WHERE platform = $1',
      [PLATFORM]
    );
    expect(rows[0].created_by_user_id).toBe('creator-A');
    expect(rows[0].catalog_etag).toBe('v2');
  });

  it('rejects a mirror with no catalog content (400)', async () => {
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send({ catalog_etag: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/catalog content/i);
  });

  it('rejects a formats[] entry missing required params — must conform to adagents.json (400)', async () => {
    const res = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ formats: [{ format_option_id: 'x', display_name: 'X', format_kind: 'image' }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conform/i);
  });

  it('rejects an invalid platform identifier (400)', async () => {
    const res = await request(app).put('/api/registry/mirrors/Bad_Platform!').send(publishBody());
    expect(res.status).toBe(400);
  });

  it('rejects a non-moderator, non-admin caller (403)', async () => {
    isRegistryModerator.mockResolvedValue(false);
    isWebUserAAOAdmin.mockResolvedValue(false);
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown mirror', async () => {
    const res = await request(app).get(`/api/registry/mirrors/${PLATFORM}`);
    expect(res.status).toBe(404);
  });

  it('serves the mirror at /translated/<platform>/adagents.json with an ETag, and 304 on If-None-Match', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'serve-etag' }));

    const served = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/^application\/json/);
    expect(served.headers['access-control-allow-origin']).toBe('*');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['etag']).toBe('"serve-etag"');
    expect(served.body.authorized_agents).toEqual([]);

    const revalidate = await request(app)
      .get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`)
      .set('If-None-Match', '"serve-etag"');
    expect(revalidate.status).toBe(304);
  });

  it('falls back to a content-hash ETag when catalog_etag is absent', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: undefined }));
    const served = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(served.status).toBe(200);
    expect(served.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/);

    const revalidate = await request(app)
      .get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`)
      .set('If-None-Match', served.headers['etag']);
    expect(revalidate.status).toBe(304);
  });

  it('serving carries superseded_by in the body and advertises it via a Link header', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ superseded_by: 'https://meta.com/.well-known/adagents.json' }));
    const served = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(served.status).toBe(200);
    // The body field is the normative SDK trigger; the Link header is an additive hint.
    expect(served.body.superseded_by).toBe('https://meta.com/.well-known/adagents.json');
    expect(served.headers['link']).toContain('rel="successor-version"');
    expect(served.headers['link']).toContain('https://meta.com/.well-known/adagents.json');
  });

  it('serving returns 404 for an unpublished platform', async () => {
    const res = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(res.status).toBe(404);
  });

  it('deletes a superseded mirror and returns the serving route to 404', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ superseded_by: 'https://meta.com/.well-known/adagents.json' }));
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
    expect((await request(app).get(`/api/registry/mirrors/${PLATFORM}`)).status).toBe(404);
    expect((await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`)).status).toBe(404);
  });

  it('refuses to delete a mirror that has not been superseded (409)', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/superseded/i);
    // The mirror is still served — fallback traffic is protected.
    expect((await request(app).get(`/api/registry/mirrors/${PLATFORM}`)).status).toBe(200);
  });

  it('force-deletes a non-superseded mirror with ?force=true', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}?force=true`);
    expect(del.status).toBe(200);
    expect((await request(app).get(`/api/registry/mirrors/${PLATFORM}`)).status).toBe(404);
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM discovered_properties WHERE publisher_domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM catalog_properties WHERE created_by = $1', [`community_adagents:${PLATFORM}`])).rows).toHaveLength(0);
  });

  it('retiring after first-party self-host takeover removes stale community properties', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    await publisherDb.upsertAdagentsCache({
      domain: PUBLISHER_DOMAIN,
      manifest: {
        authorized_agents: [],
        properties: [{
          property_id: 'self-hosted',
          property_type: 'website',
          name: 'Self Hosted Site',
          identifiers: [{ type: 'domain', value: PUBLISHER_DOMAIN }],
        }],
      },
      statusCode: 200,
      responseBytes: 512,
      resolvedUrl: `https://${PUBLISHER_DOMAIN}/.well-known/adagents.json`,
      discoveryMethod: 'direct',
    });

    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}?force=true`);
    expect(del.status).toBe(200);

    const properties = await federatedDb.getPropertiesForDomain(PUBLISHER_DOMAIN);
    expect(properties.map(p => p.name)).toEqual(['Self Hosted Site']);
    expect(properties[0]?.source_type).toBe('adagents_json');
    expect((await pool.query(
      'SELECT 1 FROM discovered_properties WHERE publisher_domain = $1 AND source_type = $2',
      [PUBLISHER_DOMAIN, 'community'],
    )).rows).toHaveLength(0);
  });

  it('returns 404 deleting an unknown mirror', async () => {
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(404);
  });

  it('rejects delete from a non-moderator, non-admin caller (403)', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ superseded_by: 'https://meta.com/.well-known/adagents.json' }));
    isRegistryModerator.mockResolvedValue(false);
    isWebUserAAOAdmin.mockResolvedValue(false);
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(403);
  });
});
